// W1-T9720: the sync-spawn meter names its caller WITHOUT making node parse and keep a source map. Under tsx
// (source maps on), read-plane.ts callerFrame formatted a 50-frame `new Error().stack` on every sync spawn, and node
// parsed each frame's module map and kept it for the life of the isolate: +134.5 MiB of heap for 587 maps, OBSERVED
// offline by the W1-T9091 builder. The caller text keeps its shape and names the position node runs instead.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const READ_PLANE = pathToFileURL(join(REPO_ROOT, "src", "lib", "read-plane.ts")).href;
const THIS_FILE = /the-sync-spawn-meter-names-its-caller-without-source-maps\.test\.ts/;

// A module that ships an inline source map (every generated line maps 100 lines on, in `mapped-original.ts`), so a
// mapped stack frame inside it is told apart from a raw one by its file and line alone.
function mappedModule(): string {
  const source = [
    'import childProcess from "node:child_process";',
    "export function spawnFromMappedModule() {",
    '  return childProcess.execFileSync(process.execPath, ["-e", ""]);',
    "}",
    "export function formatStackInMappedModule() { return new Error().stack; }",
  ].join("\n");
  const vlq = (value: number): string => {
    const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let rest = value < 0 ? (-value << 1) | 1 : value << 1;
    let out = "";
    do { let digit = rest & 31; rest >>>= 5; if (rest > 0) digit |= 32; out += digits[digit]; } while (rest > 0);
    return out;
  };
  const mappings = source.split("\n").map((_line, index) => `AA${vlq(index === 0 ? 100 : 1)}A`).join(";");
  const map = { version: 3, sources: ["mapped-original.ts"], names: [], mappings };
  return `${source}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`;
}

// Runs in a child node with --enable-source-maps. Every map node parses goes through the internal SourceMap class,
// so wrapping it counts them; the formatted `.stack` at the end is the control that proves the count sees a parse.
const DRIVER = `
import { createRequire } from "node:module";
const internal = createRequire(import.meta.url)("internal/source_map/source_map");
const parsed = [];
const Original = internal.SourceMap;
internal.SourceMap = class extends Original { constructor(payload, options) { super(payload, options); parsed.push(...payload.sources); } };
const { startReadPlaneTelemetry } = await import(process.argv[2]);
const telemetry = startReadPlaneTelemetry();
const mapped = await import(process.argv[3]);
mapped.spawnFromMappedModule();
const sample = telemetry.sample();
telemetry.stop();
const parsedByMeter = [...parsed];
const controlStack = mapped.formatStackInMappedModule();
console.log(JSON.stringify({ sourceMapsEnabled: process.sourceMapsEnabled, parsedByMeter, parsedByControl: parsed.slice(parsedByMeter.length),
  callers: sample.sync_spawn_by_caller.map((total) => total.caller), controlStack }));
`;

test("W1-T9720: metering a sync spawn parses no source map", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9720-"));
  try {
    writeFileSync(join(dir, "driver.mjs"), DRIVER);
    writeFileSync(join(dir, "mapped.mjs"), mappedModule());
    // W1-T2732: blank the coverage session var (`delete` is a no-op on it): enrolled, the child's coverage names this
    // fixture's files, which are gone by the time the suite reports, and the whole run's coverage report fails.
    const env = { ...process.env };
    env.NODE_V8_COVERAGE = undefined;
    // The real default capture path: a real node with source maps on, a real metered execFileSync, no fakes.
    const out = childProcess.execFileSync(process.execPath, ["--expose-internals", "--enable-source-maps", "--import", "tsx",
      join(dir, "driver.mjs"), READ_PLANE, pathToFileURL(join(dir, "mapped.mjs")).href], { cwd: REPO_ROOT, encoding: "utf8", env });
    const result = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { sourceMapsEnabled: boolean; parsedByMeter: string[];
      parsedByControl: string[]; callers: string[]; controlStack: string };
    assert.equal(result.sourceMapsEnabled, true, "the child source-maps its stacks, as tsx makes the daemon do");
    assert.deepEqual(result.parsedByMeter, [], "metering the spawn parsed no module's source map");
    assert.ok(result.parsedByControl.some((source) => source.endsWith("mapped-original.ts")),
      `control: formatting a stack in the mapped module parses its map, so the count sees a parse (${JSON.stringify(result.parsedByControl)})`);
    assert.match(result.controlStack, /mapped-original\.ts:10\d:/, "control: the formatted stack is source-mapped");
    assert.equal(result.callers.length, 1);
    assert.match(String(result.callers[0]), /^at Module\.spawnFromMappedModule \(\/.*[/\\]mapped\.mjs:3:\d+\)$/,
      "the caller names the function as before, and the position node runs as a plain path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// execFileSync faked UNDER the telemetry wrapper; each call advances a fake clock by the pending ms.
function withTimedSpawns(run: (telemetry: ReturnType<typeof startReadPlaneTelemetry>, setMs: (ms: number) => void) => void): void {
  const original = childProcess.execFileSync;
  let clock = 0;
  let pending = 0;
  Object.assign(childProcess, { execFileSync: () => { clock += pending; return ""; } });
  syncBuiltinESMExports();
  const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => clock) });
  try {
    run(telemetry, (ms) => { pending = ms; });
  } finally {
    telemetry.stop();
    Object.assign(childProcess, { execFileSync: original });
    syncBuiltinESMExports();
  }
}

function namedSpawnCaller(): void { childProcess.execFileSync("git", ["fetch"]); }
function callerBehindTheLeaf(worktree: string): void { hostWorktreeGit(worktree, ["status"]); }
function closureSpawnSite(): void { [0].forEach(() => { childProcess.execFileSync("git", ["status"]); }); }
class SpawningReader { constructor() { childProcess.execFileSync("gh", ["pr", "list"]); } }

test("W1-T9720: the metered caller still names the calling function and file", () => {
  const repo = mkdtempSync(join(tmpdir(), "rmd-t9720-"));
  try {
    mkdirSync(join(repo, ".git")); // a bare .git directory is all the pin reads; the spawn itself is faked
    withTimedSpawns((telemetry, setMs) => {
      setMs(2500);
      namedSpawnCaller();
      const named = telemetry.sample().sync_spawn_top[0];
      assert.match(String(named?.caller), /^at namedSpawnCaller \(\/\S+:\d+:\d+\)$/, "function name, then a plain path:line:col");
      assert.match(String(named?.caller), THIS_FILE);
      assert.equal(named?.caller_chain, undefined, "a named caller needs no chain");

      callerBehindTheLeaf(repo);
      const behind = telemetry.sample().sync_spawn_top[0];
      assert.match(String(behind?.caller), /^at callerBehindTheLeaf \(/);
      assert.equal(behind?.leaf, "hostWorktreeGit", "the leaf the caller called");

      closureSpawnSite();
      const closure = telemetry.sample().sync_spawn_top[0];
      assert.match(String(closure?.caller), /^at <anonymous> \(/, "a nameless function reads <anonymous>, as before");
      assert.match(String(closure?.caller_chain?.[0]), /^<anonymous>@the-sync-spawn-meter-names-its-caller-without-source-maps\.test\.ts:\d+$/);
      assert.ok(closure?.caller_chain?.includes("closureSpawnSite"), "the chain names the function around it");

      new SpawningReader();
      assert.match(String(telemetry.sample().sync_spawn_top[0]?.caller), /^at new SpawningReader \(/);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
