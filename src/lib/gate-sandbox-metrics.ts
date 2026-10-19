import { closeSync, constants, fstatSync, openSync, opendirSync, readFileSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export interface GateSandboxCost {
  tmp_peak_bytes: number;
  tmp_peak_scope: "boundary-sampled" | "boundary-sampled-logical-file-bytes";
  compile_cache: { files_start: number; files_end: number; bytes_start: number; bytes_end: number; start_scope: "after-module-load" };
  max_rss_kb: number;
  cpu_ms: number;
  resource_scope: "preflight-process";
}
export type GateSandboxMeasurement = { sandbox: GateSandboxCost } | { sandbox_unmeasured: string };
type CacheSize = { files: number; bytes: number };
export interface GateSandboxSources {
  tmp: () => number | TmpSample;
  cache: () => CacheSize;
  usage: () => Pick<NodeJS.ResourceUsage, "maxRSS" | "userCPUTime" | "systemCPUTime">;
}
const finiteSize = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const reason = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 220);
type TmpSample = { bytes: number; scope: GateSandboxCost["tmp_peak_scope"] };
const tmpScope = (value: unknown): value is TmpSample["scope"] => value === "boundary-sampled" || value === "boundary-sampled-logical-file-bytes";

/** A private disk bind counts named regular-file logical bytes, not the backing volume's occupancy.
 * Directories, open-unlinked files and physical allocation are not included; the scope names that distinction. */
export function privateDiskTmpBytes(root = tmpdir(), maxEntries = 10_000, now = () => performance.now(), platform: NodeJS.Platform = process.platform): number {
  if (platform !== "linux") throw Error("private disk measurement requires Linux descriptor-backed directories");
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) throw Error("temporary tree is not private to the current uid");
    const pinned = `/proc/self/fd/${fd}`, type = statfsSync(pinned, { bigint: true }).type;
    if (type === 0x01021994n || type === 0x858458f6n) throw Error("temporary tree is RAM-backed, not disk-backed");
    // The final dot is a directory, not the proc symlink: NOFOLLOW remains on the walker's open.
    return compileCacheSize(`${pinned}/.`, maxEntries, now, platform).bytes;
  } finally { closeSync(fd); }
}

/** Only a dedicated private tmpfs or the harness's private disk bind is a sandbox /tmp sample. */
export function privateTmpSample(
  root = tmpdir(),
  mountInfo = () => readFileSync("/proc/self/mountinfo", "utf8"),
  statistics = () => statfsSync(root, { bigint: true }),
  diskBytes = () => privateDiskTmpBytes(root),
): TmpSample {
  if (root !== "/tmp") throw Error("temporary directory is not the private sandbox /tmp");
  const mounts = mountInfo();
  if (mounts.length > 256 * 1024) throw Error("mount table exceeds measurement budget");
  const mount = mounts.split("\n").filter(line => line.split(" ")[4] === "/tmp").at(-1);
  const [left, right] = (mount ?? "").split(" - ");
  if (!left || right === undefined || left.split(" ").slice(6).some(field => /^(shared|master|propagate_from):/.test(field))) {
    throw Error("/tmp is not a dedicated private tmpfs or disk mount");
  }
  const stat = statistics();
  if (left.split(" ")[3]?.endsWith("/.rmd-private-tmp") && !/^(tmpfs|ramfs) /.test(right)) {
    if (stat.type === 0x01021994n || stat.type === 0x858458f6n) throw Error("/tmp is RAM-backed, not disk-backed");
    const bytes = diskBytes();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error("invalid private /tmp tree reading");
    return { bytes, scope: "boundary-sampled-logical-file-bytes" };
  }
  if (left.split(" ")[3] !== "/" || !right.startsWith("tmpfs ")) throw Error("/tmp is not a dedicated private tmpfs mount");
  if (stat.type !== 0x01021994n) throw Error("/tmp filesystem is not tmpfs");
  const bytes = Number((stat.blocks - stat.bfree) * stat.bsize);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error("invalid /tmp filesystem reading");
  return { bytes, scope: "boundary-sampled" };
}

/** Compatibility for callers that explicitly request only the byte value. */
export function privateTmpBytes(...args: Parameters<typeof privateTmpSample>): number { return privateTmpSample(...args).bytes; }

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
  const source = { tmp: privateTmpSample, cache: compileCacheSize, usage: () => process.resourceUsage(), ...sources };
  let unknown: string | undefined, peak = 0, start: CacheSize | undefined, scope: TmpSample["scope"] | undefined;
  const sample = () => {
    try {
      const value = source.tmp(), sample = typeof value === "number" ? { bytes: value, scope: "boundary-sampled" as const } : value;
      const { bytes } = sample;
      if (!finiteSize(bytes)) throw Error("invalid /tmp boundary sample");
      if (!tmpScope(sample.scope) || (scope !== undefined && scope !== sample.scope)) throw Error("/tmp byte scope changed between samples");
      scope = sample.scope;
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
          tmp_peak_bytes: peak, tmp_peak_scope: scope!,
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
  if (data.sandbox_unmeasured !== undefined || !s || !c || !tmpScope(s.tmp_peak_scope) || c.start_scope !== "after-module-load" || s.resource_scope !== "preflight-process" ||
      ![s.tmp_peak_bytes, c.files_start, c.files_end, c.bytes_start, c.bytes_end, s.max_rss_kb, s.cpu_ms].every(finiteSize)) return missing;
  return { sandbox: {
    tmp_peak_bytes: s.tmp_peak_bytes!, tmp_peak_scope: s.tmp_peak_scope,
    compile_cache: { files_start: c.files_start, files_end: c.files_end, bytes_start: c.bytes_start, bytes_end: c.bytes_end, start_scope: "after-module-load" },
    max_rss_kb: s.max_rss_kb!, cpu_ms: s.cpu_ms!, resource_scope: "preflight-process",
  } };
}
