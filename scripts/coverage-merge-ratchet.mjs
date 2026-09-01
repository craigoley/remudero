#!/usr/bin/env node

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const RAW_COVERAGE_FILE = /^coverage-\d+-\d{13}-\d+\.json$/;
const COMPACT_COVERAGE_FILE = /^coverage-bundle-\d+-\d{13}-\d+\.json$/;
const COMPACT_FORMAT = 'rmd-v8-coverage-bundle-v1';

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
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (
        entry.isFile() &&
        (RAW_COVERAGE_FILE.test(entry.name) || (includeBundles && COMPACT_COVERAGE_FILE.test(entry.name)))
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

/** Render the same LCOV fields as Node 22.22.3's built-in reporter after raw-range merging. */
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

function withStagedRawCoverage(directories, collect) {
  if (directories.length === 0) throw new Error('at least one raw coverage directory is required');
  assertPinnedNodeVersion();
  const TestCoverage = loadTestCoverage();
  const staging = mkdtempSync(join(tmpdir(), 'rmd-merge-node-coverage-'));
  let rawFileCount = 0;
  try {
    for (const directory of directories) {
      const files = coverageFilesUnder(directory, true);
      if (files.length === 0) throw new Error(`${directory} contains no V8 coverage files`);
      for (const file of files) {
        if (COMPACT_COVERAGE_FILE.test(basename(file))) {
          const bundle = JSON.parse(readFileSync(file, 'utf8'));
          if (bundle.format !== COMPACT_FORMAT || !Array.isArray(bundle.sourceMaps) || !Array.isArray(bundle.reports)) {
            throw new Error(`${file} is not a valid ${COMPACT_FORMAT} report`);
          }
          for (const report of bundle.reports) {
            if (!Array.isArray(report.result) || typeof report.sourceMapRefs !== 'object' || report.sourceMapRefs === null) {
              throw new Error(`${file} contains an invalid compact process report`);
            }
            const sourceMapCache = Object.create(null);
            for (const [url, sourceMapIndex] of Object.entries(report.sourceMapRefs)) {
              if (!Number.isSafeInteger(sourceMapIndex) || sourceMapIndex < 0 || sourceMapIndex >= bundle.sourceMaps.length) {
                throw new Error(`${file} contains an invalid source-map reference for ${url}`);
              }
              sourceMapCache[url] = bundle.sourceMaps[sourceMapIndex];
            }
            const stagedName = `coverage-${process.pid}-${Date.now()}-${rawFileCount}.json`;
            writeFileSync(join(staging, stagedName), JSON.stringify({
              result: report.result,
              'source-map-cache': sourceMapCache,
            }));
            rawFileCount += 1;
          }
        } else {
          const stagedName = `coverage-${process.pid}-${Date.now()}-${rawFileCount}.json`;
          copyFileSync(file, join(staging, stagedName));
          rawFileCount += 1;
        }
      }
    }
    const collector = new TestCoverage(
      staging,
      undefined,
      process.cwd(),
      ['test/**'],
      undefined,
      true,
      { line: 0, branch: 0, function: 0 },
    );
    return collect(collector, rawFileCount);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Deduplicate repeated source maps without changing process-report boundaries or V8 ranges.
 * Node's source-map translation mutates line-hit state in report order, so even a mathematically
 * plausible pre-merge can change LCOV line totals. The final pass reconstructs the original
 * retained process reports from this bundle without changing their ranges, then lets pinned Node
 * map and merge them exactly once.
 */
export function compactRawCoverageDirectories(directories) {
  if (directories.length === 0) throw new Error('at least one raw coverage directory is required');
  assertPinnedNodeVersion();
  const TestCoverage = loadTestCoverage();
  const collector = new TestCoverage(
    '',
    undefined,
    process.cwd(),
    ['test/**'],
    undefined,
    false,
    { line: 0, branch: 0, function: 0 },
  );
  const sourceMaps = [];
  const sourceMapIndexes = new Map();
  const reports = [];
  let rawFileCount = 0;

  for (const directory of directories) {
    const files = coverageFilesUnder(directory);
    if (files.length === 0) throw new Error(`${directory} contains no V8 coverage files`);
    for (const file of files) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      rawFileCount += 1;
      const result = (raw.result ?? []).filter((script) => !collector.shouldSkipFileCoverage(script.url));
      if (result.length === 0) continue;
      const sourceMapRefs = Object.create(null);
      for (const script of result) {
        const sourceMap = raw['source-map-cache']?.[script.url];
        if (sourceMap === undefined || sourceMap === null) continue;
        const serializedSourceMap = JSON.stringify(sourceMap);
        let sourceMapIndex = sourceMapIndexes.get(serializedSourceMap);
        if (sourceMapIndex === undefined) {
          sourceMapIndex = sourceMaps.length;
          sourceMapIndexes.set(serializedSourceMap, sourceMapIndex);
          sourceMaps.push(sourceMap);
        }
        sourceMapRefs[script.url] = sourceMapIndex;
      }
      reports.push({ result, sourceMapRefs });
    }
  }

  if (reports.length === 0) throw new Error('raw coverage compaction produced no source records');
  return { rawFileCount, bundle: { format: COMPACT_FORMAT, sourceMaps, reports } };
}

/**
 * Node's LCOV reporter numbers branches by their position in one run's branch array. Those IDs
 * are not stable across test shards. Stage every raw V8 report together, then let the exact
 * repository-pinned Node implementation merge source ranges before assigning LCOV indexes.
 */
export function mergeRawCoverageDirectories(directories) {
  return withStagedRawCoverage(directories, (collector, rawFileCount) => {
    const summary = collector.summary();
    if (summary.files.length === 0) throw new Error('raw coverage merge produced no source records');
    return { rawFileCount, summary };
  });
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      'compact-output': { type: 'string' },
    },
  });
  if (Boolean(values.output) === Boolean(values['compact-output'])) {
    throw new Error('exactly one of --output or --compact-output is required');
  }
  if (values['compact-output']) {
    const outputDirectory = values['compact-output'];
    mkdirSync(outputDirectory, { recursive: true });
    const existing = readdirSync(outputDirectory)
      .filter((name) => RAW_COVERAGE_FILE.test(name) || COMPACT_COVERAGE_FILE.test(name));
    if (existing.length > 0) throw new Error(`${outputDirectory} already contains compact coverage files`);
    const { rawFileCount, bundle } = compactRawCoverageDirectories(positionals);
    const timestamp = Date.now();
    const output = join(outputDirectory, `coverage-bundle-${process.pid}-${timestamp}-0.json`);
    writeFileSync(output, JSON.stringify(bundle));
    console.log(
      `coverage-merge-ratchet: bundled ${positionals.length} raw shard(s), ${rawFileCount} V8 file(s), ` +
        `${bundle.reports.length} retained process report(s), ${bundle.sourceMaps.length} unique source map(s) -> ${output}`,
    );
  } else {
    const { rawFileCount, summary } = mergeRawCoverageDirectories(positionals);
    writeFileSync(values.output, renderCoverageSummary(summary));
    console.log(
      `coverage-merge-ratchet: ${positionals.length} raw shard(s), ${rawFileCount} V8 file(s), ` +
        `${summary.files.length} source record(s) -> ${values.output}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`coverage-merge-ratchet: ${error.message}`);
    process.exitCode = 1;
  }
}
