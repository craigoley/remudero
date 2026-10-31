import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

/**
 * W1-T9481 — A LINE ANY SINGLE PROCESS RAN KEEPS ITS HITS THROUGH THE COVERAGE MERGE.
 *
 * A file a tsx test loads through require() (CJS-transformed, source-mapped) and a plain-node child
 * loads natively reaches the merge in two instance shapes. Node keeps them as separate function lists
 * and writes each line's count last-writer-wins, so the child's zero range erased the test's hits
 * (#11660: scripts/build-child-entries.mjs:237 read 0 with three tests running it).
 *
 * FIXTURES ONLY: the V8 reports are REAL, produced here by running a tiny module once under
 * `node --import tsx` with a require() and once under plain node; no V8 JSON is hand-written.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MERGER = join(REPO_ROOT, "scripts", "coverage-merge-ratchet.mjs");
const PROBE = "w1-t9481-probe.mjs";

// The arrow and the async function do not survive tsx's transform with their exact offsets, so the
// two shapes never join.
const PROBE_SOURCE = [
  "export const arrow = (n) => {",
  "  return n + 1;",
  "};",
  "",
  "export async function asyncFn(n) {",
  "  await null;",
  "  return n * 2;",
  "}",
  "",
].join("\n");
const lineOf = (text: string) => PROBE_SOURCE.split("\n").indexOf(text) + 1;
const RAN_BY_TSX = [lineOf("  return n + 1;"), lineOf("  await null;"), lineOf("  return n * 2;")];

function coverageEnv(directory: string): NodeJS.ProcessEnv {
  // NODE_V8_COVERAGE is set ON PURPOSE: the merge under test needs real reports to merge.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  return { ...env, NODE_V8_COVERAGE: directory };
}

type Fixture = { root: string; rawTsx: string; rawPlain: string };
let built: Fixture | undefined;

function fixture(): Fixture {
  if (built) return built;
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9481-`));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, PROBE), PROBE_SOURCE);
  writeFileSync(join(root, "tsx-driver.mjs"),
    `import { createRequire } from 'node:module';\nconst probe = createRequire(import.meta.url)('./${PROBE}');\n` +
    `for (let i = 0; i < 3; i++) probe.arrow(i);\nawait probe.asyncFn(1);\n`);
  writeFileSync(join(root, "plain-driver.mjs"), `await import('./${PROBE}');\n`);
  const run = (name: string, args: string[]) => {
    const raw = join(root, name);
    mkdirSync(raw);
    execFileSync(process.execPath, args, { cwd: root, env: coverageEnv(raw), stdio: "pipe" });
    return raw;
  };
  built = { root, rawTsx: run("raw-tsx", ["--import", "tsx", "tsx-driver.mjs"]), rawPlain: run("raw-plain", ["plain-driver.mjs"]) };
  return built;
}

after(() => {
  if (built) rmSync(built.root, { recursive: true, force: true });
});

function merger(...args: string[]): string {
  return execFileSync(process.execPath, ["--expose-internals", MERGER, ...args], { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" });
}

let outputs = 0;
function premap(...raws: string[]): string {
  const directory = join(fixture().root, `premapped-${++outputs}`);
  merger("--premap-output", directory, ...raws);
  return directory;
}

/** The merged DA counts of the probe, and the merge's log line. */
function merged(...directories: string[]): { lines: Map<number, number>; log: string } {
  const output = join(fixture().root, `merged-${++outputs}.info`);
  const log = merger("--output", output, "--shard-count", String(directories.length), ...directories);
  const record = readFileSync(output, "utf8").split("end_of_record").find((r) => new RegExp(`^SF:.*${PROBE}$`, "m").test(r));
  assert.ok(record, "the merged LCOV must carry the probe's record");
  const lines = new Map<number, number>();
  for (const [, line, count] of record!.matchAll(/^DA:(\d+),(\d+)$/gm)) lines.set(Number(line), Number(count));
  assert.ok(lines.size >= PROBE_SOURCE.split("\n").length - 1, "the probe's record must carry a DA line per source line");
  return { lines, log };
}

/** The probe's raw V8 scripts in one raw directory: generated extent and whether a source map came with it. */
function probeShapes(raw: string): Array<{ extent: number; mapped: boolean }> {
  return readdirSync(raw).filter((n) => /^coverage-.*\.json$/.test(n)).flatMap((n) => {
    const report = JSON.parse(readFileSync(join(raw, n), "utf8"));
    return (report.result as Array<{ url: string; functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number }> }> }>)
      .filter((s) => s.url.endsWith(`/${PROBE}`))
      .map((s) => ({
        extent: Math.max(...s.functions.flatMap((f) => f.ranges.filter((r) => r.startOffset === 0).map((r) => r.endOffset))),
        mapped: report["source-map-cache"]?.[s.url] != null,
      }));
  });
}

test("W1-T9481: a line a tsx process ran survives a plain-node process that never ran it", () => {
  const { rawTsx, rawPlain } = fixture();
  const [tsxShape] = probeShapes(rawTsx);
  const [plainShape] = probeShapes(rawPlain);
  assert.ok(tsxShape?.mapped && plainShape && !plainShape.mapped, "the tsx report must carry a source map for the probe and the plain one none");
  assert.notEqual(tsxShape.extent, plainShape.extent, "the two processes must load the probe in two different instance shapes");

  const own = (raw: string) => merged(premap(raw)).lines;
  for (const line of RAN_BY_TSX) {
    assert.ok(own(rawTsx).get(line)! > 0, `the tsx process alone must hit line ${line}`);
    assert.equal(own(rawPlain).get(line), 0, `the plain-node process alone must not hit line ${line}`);
  }

  // Two shards, and one shard holding both processes: the plain-node list is merged after the tsx one.
  for (const directories of [[premap(rawTsx), premap(rawPlain)], [premap(rawTsx, rawPlain)], [rawTsx, rawPlain]]) {
    const { lines, log } = merged(...directories);
    for (const line of RAN_BY_TSX) assert.ok(lines.get(line)! > 0, `line ${line} the tsx process ran must not merge down to 0`);
    const rescued = /processLineHitsRescued=(\d+)\/(\d+) /.exec(log);
    assert.ok(rescued, `the merge must report the lines it raised: ${log}`);
    assert.ok(Number(rescued[1]) >= RAN_BY_TSX.length && rescued[2] === "1", `the merge must count the probe's raised lines: ${rescued[0]}`);
    assert.match(log, /mixedShapeFiles=1 /, "the merge must report the probe as one file in mixed shapes");
  }
});

test("W1-T9481: merge order never lowers a line below one process own hit", () => {
  const { rawTsx, rawPlain } = fixture();
  const owns = [rawTsx, rawPlain].map((raw) => merged(premap(raw)).lines);
  assert.ok(owns[0]!.get(RAN_BY_TSX[0]!)! >= 3, "positive control: the tsx process ran the arrow body three times");
  const floor = new Map<number, number>();
  for (const own of owns) for (const [line, count] of own) floor.set(line, Math.max(floor.get(line) ?? 0, count));
  assert.ok([...floor.values()].filter((count) => count > 0).length >= RAN_BY_TSX.length, "the floor must hold real hits to compare against");

  const orders: Array<[string, string[]]> = [
    ["tsx shard then plain shard", [premap(rawTsx), premap(rawPlain)]],
    ["plain shard then tsx shard", [premap(rawPlain), premap(rawTsx)]],
    ["one shard, tsx then plain", [premap(rawTsx, rawPlain)]],
    ["one shard, plain then tsx", [premap(rawPlain, rawTsx)]],
    ["raw tsx then raw plain", [rawTsx, rawPlain]],
    ["raw plain then raw tsx", [rawPlain, rawTsx]],
  ];
  for (const [name, directories] of orders) {
    const { lines } = merged(...directories);
    let compared = 0;
    for (const [line, count] of floor) {
      assert.ok((lines.get(line) ?? 0) >= count, `${name}: line ${line} read ${lines.get(line)} below one process's own ${count}`);
      compared++;
    }
    assert.equal(compared, floor.size);
  }
});

/** Rewrite the premapped hit records or manifest, re-sealing sizes and checksums so the merge reads the edit. */
function tamper(directory: string, edit: (manifest: Record<string, unknown>, hits: unknown[]) => unknown[]): void {
  const manifestName = readdirSync(directory).find((name) => /^coverage-premapped-/.test(name))!;
  const manifest = JSON.parse(readFileSync(join(directory, manifestName), "utf8"));
  for (const chunk of manifest.hitChunks) {
    const parsed = JSON.parse(readFileSync(join(directory, chunk.file), "utf8"));
    parsed.hits = edit(manifest, parsed.hits);
    const source = JSON.stringify(parsed);
    writeFileSync(join(directory, chunk.file), source);
    chunk.bytes = Buffer.byteLength(source);
    chunk.sha256 = createHash("sha256").update(source).digest("hex");
    chunk.entries = parsed.hits.length;
  }
  writeFileSync(join(directory, manifestName), JSON.stringify(manifest));
}

test("W1-T9481: a premapped shard refuses an invalid or miscounted process line-hit record", () => {
  const { rawTsx } = fixture();
  const output = join(fixture().root, "refused.info");
  const refusal = (directory: string) => {
    try {
      merger("--output", output, directory);
    } catch (error) {
      return String((error as { stderr?: string }).stderr);
    }
    assert.fail("the merge must refuse the tampered shard");
  };
  const invalid = join(fixture().root, "premapped-invalid");
  assert.match(merger("--premap-output", invalid, rawTsx), /[1-9]\d* process line-hit record\(s\)/);
  tamper(invalid, (_manifest, hits) => (hits as Array<{ hits: unknown[] }>).map((record) => ({ ...record, hits: [[0, 1]] })));
  assert.match(refusal(invalid), /invalid process line-hit record/);

  const miscounted = premap(rawTsx);
  tamper(miscounted, (manifest, hits) => {
    manifest.hitFileCount = Number(manifest.hitFileCount) + 1;
    return hits;
  });
  assert.match(refusal(miscounted), /process line-hit record count mismatch/);
});
