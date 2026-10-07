#!/usr/bin/env node

import { closeSync, constants, copyFileSync, fsyncSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { isMainModule } from "./lib/argv.mjs";

const RAW_COVERAGE_FILE = /^coverage-\d+-\d{13}-\d+\.json$/;
const COMPACT_COVERAGE_FILE = /^coverage-bundle-\d+-\d{13}-\d+\.json$/;
const COMPACT_FORMAT = 'rmd-v8-coverage-bundle-v1';
const CORPUS_FILE = /^coverage-corpus-(\d+)-(\d{13})\.json$/;
const CORPUS_PIECE = /^coverage-(?:corpus|maps|reports)-/;
const CORPUS_FORMAT = 'rmd-v8-coverage-corpus-v2';
const CHUNK_BYTES = 64 * 1024 ** 2;
const CORPUS_LOCK = '.coverage-corpus-write.lock';
const digest = source => createHash('sha256').update(source).digest('hex');

function fileBytes(file) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return fstatSync(descriptor).size;
  } finally {
    closeSync(descriptor);
  }
}

function coverageFilesUnder(directory, includeBundles = false) {
  const root = resolve(directory);
  const files = [];
  function walk(path) {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      throw new Error(`cannot read raw coverage directory ${directory}: ${error.message}`);
    }
    if (includeBundles && entries.some(entry => CORPUS_PIECE.test(entry.name) || entry.name === CORPUS_LOCK)) {
      const manifests = entries.filter(entry => entry.isFile() && CORPUS_FILE.test(entry.name));
      if (manifests.length !== 1 || entries.some(entry => entry.name === CORPUS_LOCK || entry.name.endsWith('.part') ||
          RAW_COVERAGE_FILE.test(entry.name) || COMPACT_COVERAGE_FILE.test(entry.name))) {
        throw new Error(`${path} contains incomplete or mixed chunked coverage`);
      }
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (
        entry.isFile() &&
        (RAW_COVERAGE_FILE.test(entry.name) || (includeBundles && (COMPACT_COVERAGE_FILE.test(entry.name) || CORPUS_FILE.test(entry.name))))
      ) files.push(child);
    }
  }
  walk(root);
  return files.sort();
}

function assertPinnedNodeVersion() {
  const expected = readFileSync('.nvmrc', 'utf8').trim().replace(/^v/, '');
  if (process.versions.node !== expected) {
    throw new Error(
      `raw coverage merge requires the repository-pinned Node ${expected}; running ${process.versions.node}`,
    );
  }
}

function loadTestCoverage() {
  try {
    const require = createRequire(import.meta.url);
    return require('internal/test_runner/coverage').TestCoverage;
  } catch (error) {
    throw new Error(`Node's pinned raw coverage merger is unavailable; invoke with node --expose-internals (${error.message})`);
  }
}

/**
 * Construct Node's internal `TestCoverage` for either supported runtime. Node 22 takes seven
 * positional arguments `(dir, origDir, cwd, excludeGlobs, includeGlobs, sourceMaps, thresholds)`;
 * Node 24 takes `(dir, origDir, options)` with `{ cwd, coverageExcludeGlobs, coverageIncludeGlobs,
 * sourceMaps, lineCoverage, branchCoverage, functionCoverage }`. Passing the old shape to the new
 * constructor silently drops the globs and source maps, so the shape is chosen from the
 * constructor's own arity, and any other arity is refused rather than guessed.
 */
export function newTestCoverage(TestCoverage, { cwd, excludeGlobs, includeGlobs, sourceMaps }) {
  if (TestCoverage.length === 7) {
    return new TestCoverage('', undefined, cwd, excludeGlobs, includeGlobs, sourceMaps, { line: 0, branch: 0, function: 0 });
  }
  if (TestCoverage.length === 3) {
    return new TestCoverage('', undefined, {
      cwd,
      coverageExcludeGlobs: excludeGlobs,
      coverageIncludeGlobs: includeGlobs,
      sourceMaps,
      lineCoverage: 0,
      branchCoverage: 0,
      functionCoverage: 0,
    });
  }
  throw new Error(`Node ${process.versions.node}'s TestCoverage takes ${TestCoverage.length} arguments; this merger knows the 7-argument (Node 22) and 3-argument (Node 24) shapes`);
}

export function stageRawCoverageFile(file, staged, { link = linkSync, copy = copyFileSync } = {}) {
  try {
    link(file, staged);
    return 0;
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    copy(file, staged);
    return fileBytes(staged);
  }
}

/** Render the same LCOV fields as Node's built-in lcov reporter (identical in 22.22.3 and 24.21.0) after raw-range merging. */
export function renderCoverageSummary(summary) {
  const output = ['TN:'];
  for (const file of summary.files) {
    output.push(`SF:${relative(summary.workingDirectory, file.path)}`);
    let functionHits = '';
    for (let index = 0; index < file.functions.length; index += 1) {
      const func = file.functions[index];
      const name = func.name || `anonymous_${index}`;
      output.push(`FN:${func.line},${name}`);
      functionHits += `FNDA:${func.count},${name}\n`;
    }
    if (functionHits) output.push(...functionHits.trimEnd().split('\n'));
    output.push(`FNF:${file.totalFunctionCount}`, `FNH:${file.coveredFunctionCount}`);
    for (let index = 0; index < file.branches.length; index += 1) {
      const branch = file.branches[index];
      output.push(`BRDA:${branch.line},${index},0,${branch.count}`);
    }
    output.push(`BRF:${file.totalBranchCount}`, `BRH:${file.coveredBranchCount}`);
    for (const line of [...file.lines].sort((left, right) => left.line - right.line)) {
      output.push(`DA:${line.line},${line.count}`);
    }
    output.push(`LH:${file.coveredLineCount}`, `LF:${file.totalLineCount}`, 'end_of_record');
  }
  return `${output.join('\n')}\n`;
}

function readCoverageSource(file, limit = Infinity) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit) throw new Error(`${file} exceeds its coverage file byte bound or is not regular`);
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * W1-T6083: the suite one raw process report ran, repo-relative, as `{ test, root }` — or {} for a
 * spawned child's report, which names no suite. Compaction drops every test/** script, so this is
 * read BEFORE the filter; it is what lets an impact map say which suite executed what.
 */
export function reportSuiteIdentity(result, cwd = process.cwd()) {
  for (const script of result) {
    if (typeof script?.url !== 'string' || !script.url.startsWith('file:')) continue;
    const rel = relative(cwd, fileURLToPath(script.url)).split(sep).join('/');
    if (/^test\/.*\.test\.ts$/.test(rel)) return { test: rel, root: pathToFileURL(cwd + sep).href };
  }
  return {};
}

function restoreReport(report, sourceMaps, file) {
  if (!Array.isArray(report?.result) || typeof report.sourceMapRefs !== 'object' || report.sourceMapRefs === null || Array.isArray(report.sourceMapRefs)) {
    throw new Error(`${file} contains an invalid compact process report`);
  }
  const cache = Object.create(null);
  for (const [url, index] of Object.entries(report.sourceMapRefs)) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= sourceMaps.length) {
      throw new Error(`${file} contains an invalid source-map reference for ${url}`);
    }
    cache[url] = sourceMaps[index];
  }
  if (report.result.length === 0) throw new Error(`${file} contains an invalid compact process report`);
  const identity = typeof report.test === 'string' && typeof report.root === 'string' ? { test: report.test, root: report.root } : {};
  return { result: report.result, 'source-map-cache': cache, ...identity };
}

function* corpusReports(file, manifest, bytes) {
  const stem = CORPUS_FILE.exec(basename(file));
  if (manifest?.format !== CORPUS_FORMAT || !Number.isSafeInteger(manifest.maxChunkBytes) ||
      manifest.maxChunkBytes < 1024 || manifest.maxChunkBytes > CHUNK_BYTES ||
      !Number.isSafeInteger(manifest.reportCount) || manifest.reportCount < 1 ||
      !Number.isSafeInteger(manifest.sourceMapCount) || manifest.sourceMapCount < 0 ||
      !Number.isSafeInteger(manifest.rawFileCount) || manifest.rawFileCount < manifest.reportCount ||
      !Array.isArray(manifest.mapChunks) || !Array.isArray(manifest.reportChunks)) {
    throw new Error(`${file} has an invalid chunked coverage manifest`);
  }
  const expected = new Set([basename(file)]);
  const groups = [['maps', 'sourceMaps', manifest.mapChunks], ['reports', 'reports', manifest.reportChunks]];
  for (const [kind, , chunks] of groups) for (const [index, chunk] of chunks.entries()) {
    const name = `coverage-${kind}-${stem[1]}-${stem[2]}-${String(index).padStart(8, '0')}.json`;
    if (chunk?.file !== name || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > manifest.maxChunkBytes ||
        !Number.isSafeInteger(chunk.entries) || chunk.entries < 1 || !/^[a-f0-9]{64}$/.test(chunk.sha256)) {
      throw new Error(`${file} has unsafe or invalid chunk metadata`);
    }
    expected.add(name);
  }
  const actual = readdirSync(dirname(file)).filter(name => CORPUS_PIECE.test(name));
  if (actual.length !== expected.size || actual.some(name => !expected.has(name))) throw new Error(`${file} has incomplete or extra coverage chunks`);
  const readChunk = (chunk, key) => {
    const path = join(dirname(file), chunk.file);
    if (fileBytes(path) !== chunk.bytes) throw new Error(`${path} has a coverage chunk size mismatch`);
    const source = readCoverageSource(path, manifest.maxChunkBytes);
    const size = Buffer.byteLength(source);
    if (size !== chunk.bytes || digest(source) !== chunk.sha256) throw new Error(`${path} has a coverage chunk checksum mismatch`);
    const parsed = JSON.parse(source);
    if (parsed?.format !== CORPUS_FORMAT || !Array.isArray(parsed[key]) || parsed[key].length !== chunk.entries) {
      throw new Error(`${path} has invalid coverage chunk contents`);
    }
    bytes.inputBytes += size;
    return parsed[key];
  };
  const sourceMaps = [];
  for (const chunk of manifest.mapChunks) for (const map of readChunk(chunk, 'sourceMaps')) {
    if (typeof map !== 'object' || map === null || Array.isArray(map)) throw new Error(`${file} contains an invalid compact source map`);
    sourceMaps.push(map);
  }
  if (sourceMaps.length !== manifest.sourceMapCount) throw new Error(`${file} has a source-map count mismatch`);
  let count = 0;
  for (const chunk of manifest.reportChunks) for (const report of readChunk(chunk, 'reports')) {
    count++;
    bytes.rawFileCount++;
    yield restoreReport(report, sourceMaps, file);
  }
  if (count !== manifest.reportCount) throw new Error(`${file} has a process-report count mismatch`);
}

function* coverageReports(directories, bytes) {
  for (const directory of directories) {
    const files = coverageFilesUnder(directory, true);
    if (files.length === 0) throw new Error(`${directory} contains no V8 coverage files`);
    for (const file of files) {
      const source = readCoverageSource(file, CORPUS_FILE.test(basename(file)) ? CHUNK_BYTES : Infinity);
      bytes.inputBytes += Buffer.byteLength(source);
      const parsed = JSON.parse(source);
      if (CORPUS_FILE.test(basename(file))) {
        yield* corpusReports(file, parsed, bytes);
        continue;
      }
      if (!COMPACT_COVERAGE_FILE.test(basename(file))) {
        bytes.rawFileCount += 1;
        yield parsed;
        continue;
      }
      if (parsed?.format !== COMPACT_FORMAT || !Array.isArray(parsed.sourceMaps) || !Array.isArray(parsed.reports)) {
        throw new Error(`${file} is not a valid ${COMPACT_FORMAT} report`);
      }
      for (const report of parsed.reports) {
        bytes.rawFileCount += 1;
        yield restoreReport(report, parsed.sourceMaps, file);
      }
    }
  }
}

/**
 * Deduplicate repeated source maps without changing process-report boundaries or V8 ranges. Node's
 * source-map translation mutates line-hit state in report order, so even a plausible pre-merge can
 * change LCOV totals: the final pass rebuilds the retained reports unchanged, then pinned Node maps
 * and merges them exactly once.
 */
function collectCompactReports(directories, onMap, onReport) {
  if (directories.length === 0) throw new Error('at least one raw coverage directory is required');
  assertPinnedNodeVersion();
  const TestCoverage = loadTestCoverage();
  const collector = newTestCoverage(TestCoverage, { cwd: process.cwd(), excludeGlobs: ['test/**'], includeGlobs: undefined, sourceMaps: false });
  const sourceMapIndexes = new Map();
  let rawFileCount = 0;
  let reportCount = 0;

  for (const directory of directories) {
    const files = coverageFilesUnder(directory);
    if (files.length === 0) throw new Error(`${directory} contains no V8 coverage files`);
    for (const file of files) {
      const raw = JSON.parse(readCoverageSource(file));
      rawFileCount += 1;
      if (!Array.isArray(raw?.result)) throw new Error(`${file} has invalid raw coverage results`);
      const identity = reportSuiteIdentity(raw.result);
      const result = raw.result.filter((script) => !collector.shouldSkipFileCoverage(script.url));
      if (result.length === 0) continue;
      const sourceMapRefs = Object.create(null);
      for (const script of result) {
        const sourceMap = raw['source-map-cache']?.[script.url];
        if (sourceMap === undefined || sourceMap === null) continue;
        if (typeof sourceMap !== 'object' || Array.isArray(sourceMap)) throw new Error(`${file} contains an invalid raw source map`);
        const serializedSourceMap = JSON.stringify(sourceMap);
        let sourceMapIndex = sourceMapIndexes.get(serializedSourceMap);
        if (sourceMapIndex === undefined) {
          sourceMapIndex = sourceMapIndexes.size;
          sourceMapIndexes.set(serializedSourceMap, sourceMapIndex);
          onMap(serializedSourceMap, sourceMap);
        }
        sourceMapRefs[script.url] = sourceMapIndex;
      }
      onReport({ result, sourceMapRefs, ...identity });
      reportCount++;
    }
  }

  if (reportCount === 0) throw new Error('raw coverage compaction produced no source records');
  return { rawFileCount, reportCount, sourceMapCount: sourceMapIndexes.size };
}

export function compactRawCoverageDirectories(directories) {
  const sourceMaps = [];
  const reports = [];
  const { rawFileCount } = collectCompactReports(directories, (_source, map) => sourceMaps.push(map), report => reports.push(report));
  return { rawFileCount, bundle: { format: COMPACT_FORMAT, sourceMaps, reports } };
}

function atomicCoverageFile(path, source) {
  const temporary = `${path}.part`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, source); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

export function writeCompactCoverageDirectories(directories, outputDirectory, { maxChunkBytes = CHUNK_BYTES } = {}) {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1024 || maxChunkBytes > CHUNK_BYTES) throw new Error('invalid coverage chunk byte bound');
  mkdirSync(outputDirectory, { recursive: true });
  const lock = join(outputDirectory, CORPUS_LOCK);
  const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (readdirSync(outputDirectory).some(name => name !== CORPUS_LOCK)) throw new Error(`${outputDirectory} already contains compact coverage files`);
    const stem = `${process.pid}-${Date.now()}`;
    const writer = (kind, key) => {
      const header = `{"format":${JSON.stringify(CORPUS_FORMAT)},"${key}":[`;
      const chunks = [];
      let pending = [], size = Buffer.byteLength(header) + 2;
      const flush = () => {
        if (!pending.length) return;
        const source = `${header}${pending.join(',')}]}`;
        const file = `coverage-${kind}-${stem}-${String(chunks.length).padStart(8, '0')}.json`;
        atomicCoverageFile(join(outputDirectory, file), source);
        chunks.push({ file, bytes: Buffer.byteLength(source), sha256: digest(source), entries: pending.length });
        pending = []; size = Buffer.byteLength(header) + 2;
      };
      return { chunks, flush, add: source => {
        const bytes = Buffer.byteLength(source);
        if (Buffer.byteLength(header) + bytes + 2 > maxChunkBytes) throw new Error(`single coverage ${key} entry exceeds ${maxChunkBytes} byte bound`);
        if (size + bytes + (pending.length ? 1 : 0) > maxChunkBytes) flush();
        size += bytes + (pending.length ? 1 : 0); pending.push(source);
      } };
    };
    const maps = writer('maps', 'sourceMaps'), reports = writer('reports', 'reports');
    const counts = collectCompactReports(directories, source => maps.add(source), report => reports.add(JSON.stringify(report)));
    maps.flush(); reports.flush();
    const manifest = { format: CORPUS_FORMAT, maxChunkBytes, ...counts, mapChunks: maps.chunks, reportChunks: reports.chunks };
    const source = JSON.stringify(manifest);
    if (Buffer.byteLength(source) > maxChunkBytes) throw new Error('coverage manifest exceeds its byte bound');
    const output = join(outputDirectory, `coverage-corpus-${stem}.json`);
    atomicCoverageFile(output, source);
    const compactBytes = Buffer.byteLength(source) + [...maps.chunks, ...reports.chunks].reduce((sum, chunk) => sum + chunk.bytes, 0);
    return { ...counts, compactBytes, output };
  } finally { closeSync(fd); unlinkSync(lock); }
}

/**
 * Branch IDs vary across shards: feed retained reports, in order, to pinned Node's source mapper
 * and range merger before it assigns LCOV indexes. Only its directory reader changes, so repeated
 * source maps need no disk expansion; Node still owns mapping and summary algorithms.
 */
export function mergeRawCoverageDirectories(directories) {
  if (directories.length === 0) throw new Error('at least one raw coverage directory is required');
  assertPinnedNodeVersion();
  const TestCoverage = loadTestCoverage();
  const collector = newTestCoverage(TestCoverage, { cwd: process.cwd(), excludeGlobs: ['test/**'], includeGlobs: undefined, sourceMaps: true });
  const bytes = { rawFileCount: 0, inputBytes: 0 };
  collector.getCoverageFromDirectory = () => {
    const merged = new Map();
    for (const report of coverageReports(directories, bytes)) {
      collector.mergeCoverage(merged, collector.mapCoverageWithSourceMap(report));
    }
    return [...merged.values()];
  };
  const summary = collector.summary();
  if (summary.files.length === 0) throw new Error('raw coverage merge produced no source records');
  return { ...bytes, summary, stagingBytes: 0, peakBytes: bytes.inputBytes, stagingDir: 'none' };
}

// W1-T4436: refuse a merge whose shard-directory count differs from ci.yml's `--shard-count`.
export function assertExpectedShardCount(directories, expectedShardCount) {
  if (expectedShardCount === undefined) return;
  const expected = Number(expectedShardCount);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new Error(`--shard-count must be a positive integer, got ${expectedShardCount}`);
  }
  if (directories.length !== expected) {
    throw new Error(
      `expected exactly ${expected} shard director(y/ies), got ${directories.length}: ` +
        `${JSON.stringify(directories)}`,
    );
  }
}

/**
 * W1-T6083: the per-suite impact map of raw, compact or chunked coverage directories, written to
 * `output` (run with `--import tsx`: the builder is TypeScript). `sourceRoot` supplies an unmapped
 * script's text at the same sha, so its functions can be placed.
 */
export async function writeImpactMap(directories, output, { sha, sourceRoot } = {}) {
  if (directories.length === 0) throw new Error('at least one coverage directory is required');
  if (!sha) throw new Error('--impact-map requires --sha <the main sha the coverage ran on>');
  const { buildImpactMap } = await import('../src/lib/test-impact-map.ts');
  const bytes = { rawFileCount: 0, inputBytes: 0 };
  const readSource = sourceRoot === undefined ? undefined : (path) => {
    try {
      return readFileSync(join(sourceRoot, path), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const map = buildImpactMap(coverageReports(directories, bytes), { sha, root: pathToFileURL(process.cwd() + sep).href, readSource });
  writeFileSync(output, JSON.stringify(map));
  return { ...bytes, suites: map.suites.length, files: Object.keys(map.files).length, orphanReports: map.orphanReports };
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      'compact-output': { type: 'string' },
      'impact-map': { type: 'string' },
      sha: { type: 'string' },
      'source-root': { type: 'string' },
      'shard-count': { type: 'string' },
    },
  });
  if ([values.output, values['compact-output'], values['impact-map']].filter(Boolean).length !== 1) {
    throw new Error('exactly one of --output or --compact-output is required, or --impact-map alone');
  }
  assertExpectedShardCount(positionals, values['shard-count']);
  if (values['impact-map']) {
    const r = await writeImpactMap(positionals, values['impact-map'], { sha: values.sha, sourceRoot: values['source-root'] });
    console.log(
      `coverage-merge-ratchet: impact map of ${r.rawFileCount} process report(s): ${r.suites} suite(s), ${r.files} source file(s), ` +
        `${r.orphanReports} orphan report(s) -> ${values['impact-map']}`,
    );
  } else if (values['compact-output']) {
    const outputDirectory = values['compact-output'];
    const rawBytes = positionals.flatMap((directory) => coverageFilesUnder(directory)).reduce((sum, file) => sum + fileBytes(file), 0);
    const { rawFileCount, reportCount, sourceMapCount, output, compactBytes } = writeCompactCoverageDirectories(positionals, outputDirectory);
    console.log(
      `coverage-merge-ratchet: bundled ${positionals.length} raw shard(s), ${rawFileCount} V8 file(s), ` +
        `${reportCount} retained process report(s), ${sourceMapCount} unique source map(s), ` +
        `rawBytes=${rawBytes} compactBytes=${compactBytes} peakBytes=${rawBytes + compactBytes} -> ${output}`,
    );
  } else {
    const { rawFileCount, summary, inputBytes, stagingBytes, peakBytes, stagingDir } = mergeRawCoverageDirectories(positionals);
    writeFileSync(values.output, renderCoverageSummary(summary));
    console.log(
      `coverage-merge-ratchet: ${positionals.length} raw shard(s), ${rawFileCount} V8 file(s), ` +
        `${summary.files.length} source record(s), inputBytes=${inputBytes} stagingBytes=${stagingBytes} ` +
        `peakBytes=${peakBytes} stagingDir=${stagingDir} -> ${values.output}`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`coverage-merge-ratchet: ${error.message}`);
    process.exitCode = 1;
  });
}
