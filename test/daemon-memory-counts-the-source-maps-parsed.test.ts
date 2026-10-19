// W1-T9822: DAEMON.MEMORY COUNTS THE SOURCE MAPS ACTUALLY PARSED, NOT ONLY AN UPPER BOUND. Whenever maps were on, the
// source-map-cache holder reported the census ceiling (587 maps x 240,549 B = 141.2 MB, parts.upper_bound) on every
// row, so no generation-over-generation reading could show what W1-T9720 saved. The stack formatter now counts the
// distinct maps it parses (src/lib/source-map-count.ts); the row carries source_maps {enabled, parsed, parsed_basis}
// and the holder sizes the parsed maps, falling back to the ceiling only when there is no count.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonHolderSource, sampleDaemonMemoryCensus, sourceMapCacheHolder, type CensusCalibration } from "../src/lib/daemon-memory-census.js";
import {
  createSourceMapCount, installSourceMapCount, SOURCE_MAP_PARSED_BASIS, sourceMapsParsed, type SourceMapsParsedReading,
} from "../src/lib/source-map-count.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_MAP_COUNT = pathToFileURL(join(REPO_ROOT, "src", "lib", "source-map-count.ts")).href;

// Runs in a child node under --enable-source-maps and --import tsx, as the daemon runs. Node's internal SourceMap class
// is wrapped (--expose-internals, offline only) as the reference count of maps really parsed.
const DRIVER = `
import { createRequire } from "node:module";
const internal = createRequire(import.meta.url)("internal/source_map/source_map");
let reference = 0;
const Original = internal.SourceMap;
internal.SourceMap = class extends Original { constructor(payload, options) { super(payload, options); reference += 1; } };
if (process.argv[4] === "off") process.setSourceMapsEnabled(false);
const { installSourceMapCount, sourceMapsParsed } = await import(process.argv[2]);
installSourceMapCount();
const outer = await import(process.argv[3]);
const readings = [];
Error.stackTraceLimit = 2;
const across = outer.formatAcrossTwoModules();
readings.push({ parsed: sourceMapsParsed().parsed, reference });
Error.stackTraceLimit = 1;
outer.formatInnerAgain();
readings.push({ parsed: sourceMapsParsed().parsed, reference });
console.log(JSON.stringify({ enabled: process.sourceMapsEnabled, readings, across }));
`;

const INNER = `export function formatHere(): string {\n  const stack: string = new Error("inner").stack ?? "";\n  return stack;\n}\n`;
const OUTER = `import { formatHere } from "./inner.ts";\nexport function formatAcrossTwoModules(): string {\n  return formatHere();\n}\nexport function formatInnerAgain(): string {\n  return formatHere();\n}\n`;

interface DriverResult { enabled: boolean; readings: Array<{ parsed: number; reference: number }>; across: string }

function runDriver(dir: string, maps: "on" | "off"): DriverResult {
  // W1-T2732: blank the coverage session var: enrolled, the child's coverage names fixture files gone by report time.
  const env = { ...process.env };
  env.NODE_V8_COVERAGE = undefined;
  const out = childProcess.execFileSync(process.execPath, ["--expose-internals", "--enable-source-maps", "--import", "tsx",
    join(dir, "driver.mjs"), SOURCE_MAP_COUNT, pathToFileURL(join(dir, "outer.ts")).href, maps], { cwd: REPO_ROOT, encoding: "utf8", env });
  return JSON.parse(out.trim().split("\n").pop() ?? "{}") as DriverResult;
}

test("W1-T9822: the parsed count follows the maps a formatted stack touched", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9822-"));
  try {
    writeFileSync(join(dir, "driver.mjs"), DRIVER);
    writeFileSync(join(dir, "inner.ts"), INNER);
    writeFileSync(join(dir, "outer.ts"), OUTER);
    const on = runDriver(dir, "on");
    assert.equal(on.enabled, true, "the child source-maps its stacks, as tsx makes the daemon do");
    assert.match(on.across, /inner\.ts:2:\d+[\s\S]*outer\.ts:3:\d+/, "control: the stack crossed both modules and was source-mapped");
    assert.deepEqual(on.readings[0], { parsed: 2, reference: 2 }, "one stack across two mapped modules: two maps parsed, two counted");
    assert.deepEqual(on.readings[1], { parsed: 2, reference: 2 }, "formatting a module again parses nothing new, and counts nothing new");
    const off = runDriver(dir, "off");
    assert.equal(off.enabled, false);
    assert.deepEqual(off.readings, [{ parsed: 0, reference: 0 }, { parsed: 0, reference: 0 }], "with maps off nothing is parsed or counted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A call site naming only its file, as the counter reads it. */
const site = (file: string | undefined): NodeJS.CallSite => ({ getFileName: () => file }) as unknown as NodeJS.CallSite;

test("W1-T9822: the counter counts distinct mapped files after formatting, and names why it has no count", () => {
  const formatted: string[] = [];
  const target: { prepareStackTrace?: (error: Error, trace: NodeJS.CallSite[]) => unknown } = {
    prepareStackTrace: (error) => { formatted.push(error.message); return `formatted:${error.message}`; },
  };
  const mapped = new Set(["/a.ts", "/b.ts"]);
  const lookups: string[] = [];
  let enabled = true;
  const count = createSourceMapCount({ target, enabled: () => enabled, findSourceMap: (file) => { lookups.push(file); return mapped.has(file) ? {} : undefined; } });
  assert.deepEqual(count.read(), { basis: "not-installed" });
  count.install();
  const wrapper = target.prepareStackTrace;
  count.install();
  assert.equal(target.prepareStackTrace, wrapper, "a second install does not wrap the wrapper");
  assert.equal(target.prepareStackTrace!(new Error("one"), [site("/a.ts"), site("node:internal/x"), site(undefined), site(""), site("/a.ts")]), "formatted:one");
  assert.deepEqual(count.read(), { parsed: 1, basis: SOURCE_MAP_PARSED_BASIS });
  target.prepareStackTrace!(new Error("two"), [site("/b.ts"), site("/a.ts"), site("/plain.js")]);
  assert.deepEqual(count.read(), { parsed: 2, basis: SOURCE_MAP_PARSED_BASIS });
  assert.deepEqual(lookups, ["/a.ts", "node:internal/x", "/b.ts", "/plain.js"], "each file is looked up once, never again");
  enabled = false;
  mapped.add("/c.ts");
  target.prepareStackTrace!(new Error("off"), [site("/c.ts")]);
  assert.equal(count.read().parsed, 2, "with maps off the formatter parses nothing, so nothing is counted");
  assert.deepEqual(formatted, ["one", "two", "off"], "every stack is still formatted by the formatter it wrapped");
  // Something else left in prepareStackTrace stops the count seeing parses: no number, a reason.
  const foreign = (): string => "foreign";
  target.prepareStackTrace = foreign;
  assert.deepEqual(count.read(), { basis: "detached" });
  count.uninstall();
  assert.equal(target.prepareStackTrace, foreign, "uninstall never removes a formatter it did not put there");
  assert.deepEqual(count.read(), { basis: "not-installed" });
  const original = (): string => "original";
  const restored: { prepareStackTrace?: (error: Error, trace: NodeJS.CallSite[]) => unknown } = { prepareStackTrace: original };
  const again = createSourceMapCount({ target: restored, enabled: () => true, findSourceMap: () => undefined });
  again.install();
  assert.notEqual(restored.prepareStackTrace, original);
  again.uninstall();
  assert.equal(restored.prepareStackTrace, original, "uninstall restores what was there before");
});

test("W1-T9822: a counting error is named as failed, and the stack is still formatted", () => {
  const target: { prepareStackTrace?: (error: Error, trace: NodeJS.CallSite[]) => unknown } = { prepareStackTrace: () => "formatted" };
  const count = createSourceMapCount({ target, enabled: () => true, findSourceMap: () => { throw new Error("lookup broke"); } });
  count.install();
  assert.equal(target.prepareStackTrace!(new Error("x"), [site("/a.ts")]), "formatted");
  assert.deepEqual(count.read(), { basis: "failed", error: "lookup broke" });
  assert.equal(target.prepareStackTrace!(new Error("y"), [site("/b.ts")]), "formatted", "a failed count keeps formatting");
  const noFormatter = createSourceMapCount({ target: {}, enabled: () => true });
  noFormatter.install();
  assert.deepEqual(noFormatter.read(), { basis: "not-installed" }, "with no formatter to wrap, nothing is installed");
  const thrownTarget: { prepareStackTrace?: (error: Error, trace: NodeJS.CallSite[]) => unknown } = { prepareStackTrace: () => "x" };
  const thrown = createSourceMapCount({ target: thrownTarget, enabled: () => true, findSourceMap: () => { throw "not an error"; } });
  thrown.install();
  thrownTarget.prepareStackTrace!(new Error("z"), [site("/a.ts")]);
  assert.deepEqual(thrown.read(), { basis: "failed", error: "not an error" }, "a non-Error throw is named too");
});

test("W1-T9822: the real formatter, wrapped in this process, counts this test file's map and is restored", () => {
  const before = Error.prepareStackTrace;
  const count = createSourceMapCount();
  count.install();
  try {
    assert.notEqual(Error.prepareStackTrace, before);
    const stack = new Error("real").stack ?? "";
    assert.match(stack, /daemon-memory-counts-the-source-maps-parsed\.test\.ts/);
    const reading = count.read();
    assert.equal(reading.basis, SOURCE_MAP_PARSED_BASIS);
    assert.ok((reading.parsed ?? -1) >= (process.sourceMapsEnabled ? 1 : 0), `this test file is mapped under tsx (${JSON.stringify(reading)})`);
  } finally {
    count.uninstall();
  }
  assert.equal(Error.prepareStackTrace, before);
  installSourceMapCount();
  installSourceMapCount();
  assert.equal(sourceMapsParsed().basis, SOURCE_MAP_PARSED_BASIS, "the process count installs once and reads a count");
});

const table: Record<string, CensusCalibration> = { "source-maps.module": { per_entry_bytes: 240_000, entries: 587, census_sha: "a".repeat(40), census_date: "2026-10-15" } };
const counted = (parsed: number) => (): SourceMapsParsedReading => ({ parsed, basis: SOURCE_MAP_PARSED_BASIS });

test("W1-T9822: the source-map holder sizes the parsed maps, not the ceiling", () => {
  let enabled = true;
  let reading: SourceMapsParsedReading = { parsed: 5, basis: SOURCE_MAP_PARSED_BASIS };
  const holder = sourceMapCacheHolder(() => enabled, table, () => reading);
  assert.deepEqual(holder.size!(), { entries: 5, bytes: 5 * 240_000, basis: "census", calibration: "source-maps.module@aaaaaaaaaaaa/2026-10-15",
    parts: { formatted_frames: 1 } });
  reading = { parsed: 0, basis: SOURCE_MAP_PARSED_BASIS };
  assert.equal(holder.size!()!.bytes, 0, "no map parsed is no map held, not the ceiling");
  for (const basis of ["not-installed", "detached", "failed"] as const) {
    reading = { basis };
    assert.deepEqual(holder.size!(), { entries: 587, bytes: 587 * 240_000, basis: "census", calibration: "source-maps.module@aaaaaaaaaaaa/2026-10-15",
      parts: { upper_bound: 1 } }, `${basis}: the ceiling only when there is no count`);
  }
  enabled = false;
  assert.deepEqual(holder.size!(), { entries: 0, bytes: 0, basis: "census", parts: { source_maps_enabled: 0 } });
  assert.deepEqual(sourceMapCacheHolder(() => true, {}, counted(3)).size!(), { entries: 0, bytes: 0, basis: "census", parts: { uncalibrated: 1 } });
  assert.deepEqual(sourceMapCacheHolder(() => true, {}, () => ({ basis: "detached" })).size!(), { entries: 0, bytes: 0, basis: "census", parts: { uncalibrated: 1 } });
  // The daemon's holder list installs the count once and sizes the holder from it.
  let installs = 0;
  const listed = daemonHolderSource({ sourceMapsEnabled: () => true, table, sourceMapCount: { install: () => { installs += 1; }, read: counted(4) } })();
  assert.equal(installs, 1);
  assert.equal(listed.find((h) => h.name === "source-map-cache")!.size!()!.bytes, 4 * 240_000);
  // Its default is the process's own count, installed by building the list.
  const real = daemonHolderSource({ sourceMapsEnabled: () => true, table })().find((h) => h.name === "source-map-cache")!.size!()!;
  assert.deepEqual(real.parts, { formatted_frames: 1 });
  assert.equal(sourceMapsParsed().basis, SOURCE_MAP_PARSED_BASIS);
});

const quietIo = {
  heapStatistics: () => ({ used_heap_size: 1, total_heap_size: 2, total_physical_size: 2, heap_size_limit: 4, external_memory: 0, malloced_memory: 0,
    number_of_native_contexts: 1, number_of_detached_contexts: 0, used_global_handles_size: 0 }) as never,
  heapSpaces: () => [],
  heapCode: () => ({ bytecode_and_metadata_size: 0, code_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 }),
  memoryUsage: () => ({ rss: 10, heapTotal: 2, heapUsed: 1, external: 0, arrayBuffers: 0 }),
  procStatus: () => "VmRSS:\t1 kB\nVmSwap:\t0 kB\nVmHWM:\t1 kB\nRssAnon:\t1 kB\nRssFile:\t0 kB\n",
  sourceMapsEnabled: () => true,
  uptimeSeconds: () => 5,
};

test("W1-T9822: the daemon memory row carries source_maps enabled and parsed", async () => {
  const row = await sampleDaemonMemoryCensus([], {}, { ...quietIo, sourceMapsParsed: counted(7) });
  assert.deepEqual(row.source_maps, { enabled: true, parsed: 7, parsed_basis: SOURCE_MAP_PARSED_BASIS });
  assert.equal(row.source_maps_enabled, true, "kept for its readers");
  const detached = await sampleDaemonMemoryCensus([], {}, { ...quietIo, sourceMapsEnabled: () => false, sourceMapsParsed: () => ({ basis: "detached" }) });
  assert.deepEqual(detached.source_maps, { enabled: false, parsed_basis: "detached" }, "no count is no number, and the reason is named");
  assert.equal(detached.source_maps_enabled, false);
  const real = await sampleDaemonMemoryCensus([], {}, { ...quietIo, sourceMapsEnabled: undefined });
  assert.equal(typeof (real.source_maps as { parsed_basis: unknown }).parsed_basis, "string");
  assert.equal((real.source_maps as { enabled: unknown }).enabled, process.sourceMapsEnabled);
});
