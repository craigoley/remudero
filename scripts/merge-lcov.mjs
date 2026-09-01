#!/usr/bin/env node

import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const RAW_COVERAGE_FILE = /^coverage-\d+-\d{13}-\d+\.json$/;

function coverageFilesUnder(directory) {
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
      else if (entry.isFile() && RAW_COVERAGE_FILE.test(entry.name)) files.push(child);
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

function withStagedRawCoverage(directories, sourceMaps, collect) {
  if (directories.length === 0) throw new Error('at least one raw coverage directory is required');
  assertPinnedNodeVersion();
  const TestCoverage = loadTestCoverage();
  const staging = mkdtempSync(join(tmpdir(), 'rmd-merge-node-coverage-'));
  const sourceMapCache = Object.create(null);
  const serializedSourceMaps = new Map();
  let rawFileCount = 0;
  try {
    for (const directory of directories) {
      const files = coverageFilesUnder(directory);
      if (files.length === 0) throw new Error(`${directory} contains no V8 coverage files`);
      for (const file of files) {
        if (!sourceMaps) {
          const raw = JSON.parse(readFileSync(file, 'utf8'));
          for (const [url, sourceMap] of Object.entries(raw['source-map-cache'] ?? {})) {
            const serialized = JSON.stringify(sourceMap);
            const previous = serializedSourceMaps.get(url);
            if (previous !== undefined && previous !== serialized) {
              throw new Error(`raw coverage files disagree on the source map for ${url}`);
            }
            serializedSourceMaps.set(url, serialized);
            sourceMapCache[url] = sourceMap;
          }
        }
        const stagedName = `coverage-${process.pid}-${Date.now()}-${rawFileCount}.json`;
        copyFileSync(file, join(staging, stagedName));
        rawFileCount += 1;
      }
    }
    const collector = new TestCoverage(
      staging,
      undefined,
      process.cwd(),
      ['test/**'],
      undefined,
      sourceMaps,
      { line: 0, branch: 0, function: 0 },
    );
    return collect(collector, rawFileCount, sourceMapCache);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Collapse one shard's many process reports into one V8-compatible report. Unlike LCOV,
 * the compact result retains generated-code offsets plus their source-map cache. Deferring
 * source-map translation until the final pass preserves Node's source-line hit accounting while
 * another TestCoverage pass merges four compact reports without multiplying branch records.
 */
export function compactRawCoverageDirectories(directories) {
  return withStagedRawCoverage(directories, false, (collector, rawFileCount, sourceMapCache) => {
    const result = collector.getCoverageFromDirectory();
    if (result.length === 0) throw new Error('raw coverage compaction produced no source records');
    return { rawFileCount, result, sourceMapCache };
  });
}

/**
 * Node's LCOV reporter numbers branches by their position in one run's branch array. Those IDs
 * are not stable across test shards. Stage every raw V8 report together, then let the exact
 * repository-pinned Node implementation merge source ranges before assigning LCOV indexes.
 */
export function mergeRawCoverageDirectories(directories) {
  return withStagedRawCoverage(directories, true, (collector, rawFileCount) => {
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
    const { rawFileCount, result, sourceMapCache } = compactRawCoverageDirectories(positionals);
    writeFileSync(values['compact-output'], JSON.stringify({ result, 'source-map-cache': sourceMapCache }));
    console.log(
      `merge-lcov: compacted ${positionals.length} raw shard(s), ${rawFileCount} V8 file(s), ` +
        `${result.length} source record(s) -> ${values['compact-output']}`,
    );
  } else {
    const { rawFileCount, summary } = mergeRawCoverageDirectories(positionals);
    writeFileSync(values.output, renderCoverageSummary(summary));
    console.log(
      `merge-lcov: ${positionals.length} raw shard(s), ${rawFileCount} V8 file(s), ` +
        `${summary.files.length} source record(s) -> ${values.output}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`merge-lcov: ${error.message}`);
    process.exitCode = 1;
  }
}
