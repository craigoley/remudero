import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRECHECK = pathToFileURL(join(ROOT, "scripts/census-precheck.mjs")).href;
const SLOT = pathToFileURL(join(ROOT, "src/lib/test-slot.ts")).href;
const TSX = import.meta.resolve("tsx");
const MERGER = join(ROOT, "scripts/coverage-merge-ratchet.mjs");

type Script = { url: string; functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }> };
type Report = { result: Script[]; "source-map-cache": Record<string, unknown> };

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}load-once-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function child(directory: string, args: string[], code: string, options = "", collectInSuiteCoverage = false): string {
  const { NODE_TEST_CONTEXT: _context, NODE_V8_COVERAGE: _coverage, NODE_OPTIONS: _options, ...env } = process.env;
  mkdirSync(directory, { recursive: true });
  const coverageDirectory = collectInSuiteCoverage ? (process.env.NODE_V8_COVERAGE ?? directory) : directory;
  return execFileSync(process.execPath, ["--enable-source-maps", ...args, "--input-type=module", "-e", code], {
    cwd: ROOT, encoding: "utf8", env: { ...env, NODE_OPTIONS: options, NODE_V8_COVERAGE: coverageDirectory },
  });
}

function reports(directory: string): Report[] {
  const files = readdirSync(directory).filter((name) => /^coverage-\d+-\d{13}-\d+\.json$/.test(name));
  assert.ok(files.length > 0, "the child must produce real V8 reports");
  return files.map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
}

function normalizedFileUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "file:") return url.href;
  url.search = "";
  url.hash = "";
  try {
    return pathToFileURL(realpathSync(fileURLToPath(url))).href;
  } catch {
    return url.href; // V8 also reports synthetic file URLs such as [eval1].
  }
}

const PRECHECK_PROBE = `
  const precheck = await import(${JSON.stringify(PRECHECK)});
  precheck.runCensusSuitesViaChild({ root: process.cwd(), files: ["test/probe.test.ts"],
    run(file, args) { console.log(JSON.stringify({file, args})); return {status: 0, stdout: "# tests 1\\n"}; }
  });
`;

test("W1-T6180: a precheck child under tsx compiles each source file once", (t) => {
  const root = scratch(t);
  const modes = [
    { name: "cli", args: ["--import", "tsx"], options: "", prefix: "" },
    { name: "url", args: [`--import=${TSX}`], options: "", prefix: "" },
    { name: "env", args: [], options: `--import=${TSX}`, prefix: "" },
    { name: "registered", args: [], options: "", prefix: 'const {register} = await import("tsx/esm/api"); register();' },
  ];
  for (const mode of modes) {
    const directory = join(root, mode.name);
    const output = child(directory, mode.args,
      `${mode.prefix} await import(${JSON.stringify(SLOT)}); ${PRECHECK_PROBE}`, mode.options);
    assert.ok(JSON.parse(output).args.some((arg: string) => arg.startsWith("--test-concurrency=")), output);
    const sourceReports = reports(directory).map((report) => report.result.filter((script) => script.url.startsWith(pathToFileURL(join(ROOT, "src") + "/").href)));
    const relevant = sourceReports.filter((scripts) => scripts.some((script) => normalizedFileUrl(script.url) === normalizedFileUrl(SLOT)));
    assert.equal(relevant.length, 1, `${mode.name}: the main child must report test-slot.ts`);
    const counts = new Map<string, number>();
    for (const script of relevant[0]!) {
      const url = normalizedFileUrl(script.url);
      counts.set(url, (counts.get(url) ?? 0) + 1);
    }
    assert.ok([...counts.keys()].some((url) => url.endsWith("/drain-lock.ts")), "the imported graph is measured too");
    for (const [url, count] of counts) assert.equal(count, 1, `${mode.name}: ${url} compiled ${count} times`);
  }
});

test("W1-T6180: a plain node precheck still loads test-slot through tsImport", (t) => {
  const output = child(join(scratch(t), "plain"), [], PRECHECK_PROBE, "", true);
  const command = JSON.parse(output) as { args: string[] };
  assert.ok(command.args.some((arg) => arg.startsWith("--test-concurrency=")), output);
});

function merger(...args: string[]): string {
  return execFileSync(process.execPath, ["--expose-internals", MERGER, ...args], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
}

const SCANNERS = ["src/lib/trust-root-text.ts", "src/lib/rule-suites.ts"] as const;

test("W1-T13604 criterion 1: each loader mode maps each scanner exactly once", (t) => {
  const root = scratch(t);
  const modes = [
    { name: "plain", args: [], options: "", prefix: "" },
    { name: "cli", args: ["--import", "tsx"], options: "", prefix: "" },
    { name: "env", args: [], options: `--import=${TSX}`, prefix: "" },
    { name: "registered", args: [], options: "", prefix: 'const {register} = await import("tsx/esm/api"); register();' },
  ];
  for (const mode of modes) {
    const raw = join(root, mode.name);
    child(raw, mode.args, mode.prefix + PRECHECK_PROBE, mode.options);
    const evidence = reports(raw);
    for (const file of SCANNERS) {
      const url = normalizedFileUrl(pathToFileURL(join(ROOT, file)).href);
      const loads = evidence.flatMap(report => report.result
        .filter(script => normalizedFileUrl(script.url) === url)
        .map(script => Boolean(report["source-map-cache"]?.[script.url])));
      assert.deepEqual(loads, [true], `${mode.name}: ${file} must be loaded once with a real source map`);
    }
  }
});

function scannerRecord(lcov: string, file: typeof SCANNERS[number]): string {
  const record = lcov.split("end_of_record").find(block => block.split("\n")
    .some(line => line === `SF:${file}` || (line.startsWith("SF:") && line.endsWith(`/${file}`))));
  assert.ok(record, `must include an SF record for ${file}`);
  return record;
}

function scannerTotals(lcov: string): unknown {
  return Object.fromEntries(SCANNERS.map(file => [file, scannerRecord(lcov, file).split("\n")
    .filter(line => /^(LH|LF|BRH|BRF):/.test(line))]));
}

function scannerShards(root: string, t: TestContext) {
  return [
    { name: "plain", args: [] },
    { name: "tsx", args: ["--import", TSX] },
  ].map(({ name, args }) => {
    const raw = join(root, name);
    child(raw, args, PRECHECK_PROBE);
    const lcov = join(root, `${name}.info`);
    const premapped = join(root, `${name}-premapped`);
    merger("--output", lcov, raw);
    t.diagnostic(`${name} shard scanner counts: ${JSON.stringify(scannerTotals(readFileSync(lcov, "utf8")))}`);
    merger("--premap-output", premapped, raw);
    return { raw, premapped, lcov };
  });
}

test("W1-T13604 criterion 2: real raw and premapped shard coverage merges in both orders", (t) => {
  const root = scratch(t);
  const shards = scannerShards(root, t);
  for (const representation of ["raw", "premapped"] as const) {
    for (const ordered of [shards, [...shards].reverse()]) {
      const output = join(root, "aggregate.info");
      merger("--output", output, "--shard-count", "2",
        ...ordered.flatMap(shard => ["--line-lcov", shard.lcov]),
        ...ordered.map(shard => shard[representation]));
      const lcov = readFileSync(output, "utf8");
      for (const file of SCANNERS) assert.match(scannerRecord(lcov, file), /^DA:\d+,[1-9]/m);
      t.diagnostic(`${representation} aggregate scanner counts: ${JSON.stringify(scannerTotals(lcov))}`);
    }
  }
});

test("W1-T13604 criterion 3: positive shard evidence outside the aggregate still refuses", (t) => {
  const root = scratch(t);
  const raw = join(root, "mapped");
  child(raw, ["--import", TSX], PRECHECK_PROBE);
  const file = SCANNERS[0];
  const lcov = join(root, "invalid.info");
  writeFileSync(lcov, `SF:${file}\nDA:1000000,1\nend_of_record\n`);
  assert.throws(() => merger("--output", join(root, "refused.info"), "--line-lcov", lcov, raw),
    /shard LCOV reports a positive hit outside aggregate source src\/lib\/trust-root-text\.ts:1000000/);
});

test("W1-T6180: the merge summary counts the repeated instances it dropped", (t) => {
  const root = scratch(t);
  const probe = join(root, "probe.ts");
  writeFileSync(probe, "export const value: number = 42;\nconsole.log(value);\n");
  const original = join(root, "original");
  child(original, ["--import", TSX], `await import(${JSON.stringify(pathToFileURL(probe).href)});`);
  const probeUrl = normalizedFileUrl(pathToFileURL(probe).href);
  const report = reports(original).find((r) => r.result.some((s) => normalizedFileUrl(s.url) === probeUrl))!;
  const script = report.result.find((s) => normalizedFileUrl(s.url) === probeUrl)!;
  assert.ok(report["source-map-cache"][script.url], "the retained instance has a real source map");
  const rawDirectories = [0, 1, 2].map((drops) => {
    const directory = join(root, `raw-${drops}`);
    mkdirSync(directory);
    const repeats = Array.from({ length: drops }, () => {
      const duplicate = structuredClone(script);
      for (const fn of duplicate.functions) for (const range of fn.ranges) { range.endOffset += 1; range.count = 0; }
      return duplicate;
    });
    writeFileSync(join(directory, "coverage-1-0000000000000-0.json"), JSON.stringify({
      result: [script, ...repeats], "source-map-cache": { [script.url]: report["source-map-cache"][script.url] },
    }));
    return directory;
  });
  const clean = join(root, "clean.info");
  assert.match(merger("--output", clean, rawDirectories[0]!), /droppedRepeatInstances=0\b/);
  const rawOutput = join(root, "raw.info");
  assert.match(merger("--output", rawOutput, ...rawDirectories.slice(1)), /droppedRepeatInstances=3\b/);
  assert.match(readFileSync(rawOutput, "utf8"), /^DA:\d+,[1-9]/m, "retained hits survive");
  const premapped = rawDirectories.slice(1).map((raw, index) => {
    const directory = join(root, `premapped-${index}`);
    assert.match(merger("--premap-output", directory, raw), new RegExp(`droppedRepeatInstances=${index + 1}\\b`));
    return directory;
  });
  const replayed = join(root, "replayed.info");
  assert.match(merger("--output", replayed, ...premapped), /droppedRepeatInstances=3\b/);
  assert.equal(readFileSync(replayed, "utf8"), readFileSync(rawOutput, "utf8"));
  const compact = join(root, "compact");
  assert.match(merger("--compact-output", compact, ...rawDirectories.slice(1)), /droppedRepeatInstances=3\b/);
  const premappedCompact = join(root, "premapped-compact");
  assert.match(merger("--premap-output", premappedCompact, compact), /droppedRepeatInstances=3\b/);
  const compactOutput = join(root, "compact.info");
  assert.match(merger("--output", compactOutput, compact), /droppedRepeatInstances=3\b/);
  assert.equal(readFileSync(compactOutput, "utf8"), readFileSync(rawOutput, "utf8"));

  const bundleDirectory = join(root, "bundle");
  mkdirSync(bundleDirectory);
  const bundleFile = join(bundleDirectory, "coverage-bundle-1-0000000000000-0.json");
  execFileSync(process.execPath, ["--expose-internals", "--input-type=module", "-e", `
    import {writeFileSync} from "node:fs";
    import {compactRawCoverageDirectories} from ${JSON.stringify(pathToFileURL(MERGER).href)};
    writeFileSync(process.argv[1], JSON.stringify(compactRawCoverageDirectories(process.argv.slice(2)).bundle));
  `, bundleFile, ...rawDirectories.slice(1)], { cwd: ROOT, stdio: "pipe" });
  const bundleOutput = join(root, "bundle.info");
  assert.match(merger("--output", bundleOutput, bundleDirectory), /droppedRepeatInstances=3\b/);
  assert.equal(readFileSync(bundleOutput, "utf8"), readFileSync(rawOutput, "utf8"));

  for (const directory of [bundleDirectory, compact, ...premapped]) {
    const name = readdirSync(directory).find((file) => /^coverage-(bundle|corpus|premapped)-/.test(file))!;
    const path = join(directory, name);
    const record = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(record.droppedRepeatInstances, directory === premapped[0] ? 1 : directory === premapped[1] ? 2 : 3);
    for (const invalid of [-1, 0.5, "3", null]) {
      writeFileSync(path, JSON.stringify({ ...record, droppedRepeatInstances: invalid }));
      assert.throws(() => merger("--output", join(root, "invalid.info"), directory), /invalid droppedRepeatInstances count/);
    }
    delete record.droppedRepeatInstances;
    writeFileSync(path, JSON.stringify(record));
    assert.match(merger("--output", join(root, "legacy.info"), directory), /droppedRepeatInstances=0\b/);
  }
});
