#!/usr/bin/env node
import { relative, sep } from "node:path";

/** Node test reporter that records the file-wrapper wall time without double-counting children. */
export async function* durationReport(source, { cwd = process.cwd() } = {}) {
  const durations = new Map();
  for await (const event of source) {
    if (event?.type !== "test:complete" || event.data?.nesting !== 0) continue;
    // Imported modules also register top-level tests. Only the runner's physical
    // file wrapper has its absolute file path as its name on Node 22 and 24.
    if (event.data?.name !== event.data?.file) continue;
    const duration = event.data?.details?.duration_ms;
    if (typeof event.data?.file !== "string" || !Number.isFinite(duration) || duration < 0) continue;
    const path = relative(cwd, event.data.file);
    if (path === ".." || path.startsWith(`..${sep}`) || !path.endsWith(".test.ts")) continue;
    const normalized = path.split(sep).join("/");
    durations.set(normalized, Math.max(durations.get(normalized) ?? 0, duration));
  }
  const files = Object.fromEntries(
    [...durations].sort(([a], [b]) => a.localeCompare(b)).map(([path, duration]) => [path, Math.ceil(duration)]),
  );
  yield `${JSON.stringify({ version: 1, files })}\n`;
}

export default durationReport;
