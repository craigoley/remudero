#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

function emptyRecord(path) {
  return {
    path,
    functions: new Map(),
    functionHits: new Map(),
    branches: new Map(),
    lines: new Map(),
  };
}

function maximum(previous, next) {
  return Math.max(previous ?? 0, Number(next));
}

/** Parse one shard while collapsing duplicate records within that shard by hit state. */
export function parseLcovReport(text) {
  const records = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      const path = line.slice(3).trim();
      if (!path) throw new Error('LCOV source record has an empty path');
      current = records.get(path) ?? emptyRecord(path);
      records.set(path, current);
      continue;
    }
    if (line === 'end_of_record') {
      current = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('FN:')) {
      const comma = line.indexOf(',', 3);
      if (comma === -1) throw new Error(`malformed LCOV function declaration: ${line}`);
      const sourceLine = Number(line.slice(3, comma));
      const name = line.slice(comma + 1);
      if (!Number.isInteger(sourceLine) || !name) throw new Error(`malformed LCOV function declaration: ${line}`);
      current.functions.set(name, Math.max(current.functions.get(name) ?? 0, sourceLine));
    } else if (line.startsWith('FNDA:')) {
      const comma = line.indexOf(',', 5);
      if (comma === -1) throw new Error(`malformed LCOV function hits: ${line}`);
      const hits = Number(line.slice(5, comma));
      const name = line.slice(comma + 1);
      if (!Number.isFinite(hits) || !name) throw new Error(`malformed LCOV function hits: ${line}`);
      current.functionHits.set(name, maximum(current.functionHits.get(name), hits));
    } else if (line.startsWith('BRDA:')) {
      const fields = line.slice(5).split(',');
      if (fields.length !== 4) throw new Error(`malformed LCOV branch hits: ${line}`);
      const [sourceLine, block, branch, rawTaken] = fields;
      const key = `${sourceLine},${block},${branch}`;
      const taken = rawTaken === '-' ? null : Number(rawTaken);
      if (taken !== null && !Number.isFinite(taken)) throw new Error(`malformed LCOV branch hits: ${line}`);
      const previous = current.branches.get(key);
      current.branches.set(key, previous === undefined || previous === null ? taken : taken === null ? previous : Math.max(previous, taken));
    } else if (line.startsWith('DA:')) {
      const [sourceLine, rawHits] = line.slice(3).split(',');
      const lineNumber = Number(sourceLine);
      const hits = Number(rawHits);
      if (!Number.isInteger(lineNumber) || !Number.isFinite(hits)) throw new Error(`malformed LCOV line hits: ${line}`);
      current.lines.set(lineNumber, maximum(current.lines.get(lineNumber), hits));
    }
  }
  if (records.size === 0) throw new Error('LCOV shard contains no source records');
  return records;
}

/** Merge shard reports by unioning hit state; raw concatenation would double-count denominators. */
export function mergeLcovReports(reports) {
  const merged = new Map();
  for (const report of reports) {
    for (const [path, incoming] of report) {
      const target = merged.get(path) ?? emptyRecord(path);
      merged.set(path, target);
      for (const [name, sourceLine] of incoming.functions) {
        target.functions.set(name, Math.max(target.functions.get(name) ?? 0, sourceLine));
      }
      for (const [name, hits] of incoming.functionHits) {
        target.functionHits.set(name, maximum(target.functionHits.get(name), hits));
      }
      for (const [key, taken] of incoming.branches) {
        const previous = target.branches.get(key);
        target.branches.set(key, previous === undefined || previous === null ? taken : taken === null ? previous : Math.max(previous, taken));
      }
      for (const [lineNumber, hits] of incoming.lines) {
        target.lines.set(lineNumber, maximum(target.lines.get(lineNumber), hits));
      }
    }
  }
  if (merged.size === 0) throw new Error('no LCOV source records were available to merge');
  return merged;
}

function numericKey(value) {
  return value.split(',').map(Number);
}

function compareNumericKeys(left, right) {
  const a = numericKey(left);
  const b = numericKey(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Render one canonical record per source and recompute all derived LCOV totals. */
export function renderMergedLcov(records) {
  const output = [];
  for (const path of [...records.keys()].sort()) {
    const record = records.get(path);
    output.push('TN:', `SF:${path}`);
    const functions = [...record.functions].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    for (const [name, sourceLine] of functions) output.push(`FN:${sourceLine},${name}`);
    const functionNames = new Set([...record.functions.keys(), ...record.functionHits.keys()]);
    for (const name of [...functionNames].sort()) output.push(`FNDA:${record.functionHits.get(name) ?? 0},${name}`);
    output.push(`FNF:${functionNames.size}`);
    output.push(`FNH:${[...functionNames].filter((name) => (record.functionHits.get(name) ?? 0) > 0).length}`);
    for (const [key, taken] of [...record.branches].sort((a, b) => compareNumericKeys(a[0], b[0]))) {
      output.push(`BRDA:${key},${taken === null ? '-' : taken}`);
    }
    output.push(`BRF:${record.branches.size}`);
    output.push(`BRH:${[...record.branches.values()].filter((taken) => taken !== null && taken > 0).length}`);
    for (const [lineNumber, hits] of [...record.lines].sort((a, b) => a[0] - b[0])) output.push(`DA:${lineNumber},${hits}`);
    output.push(`LF:${record.lines.size}`);
    output.push(`LH:${[...record.lines.values()].filter((hits) => hits > 0).length}`);
    output.push('end_of_record');
  }
  return `${output.join('\n')}\n`;
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { output: { type: 'string', short: 'o' } },
  });
  if (!values.output) throw new Error('--output is required');
  if (positionals.length === 0) throw new Error('at least one LCOV shard path is required');
  const reports = positionals.map((path) => {
    const text = readFileSync(path, 'utf8');
    try {
      return parseLcovReport(text);
    } catch (error) {
      throw new Error(`${path}: ${error.message}`);
    }
  });
  const merged = mergeLcovReports(reports);
  const rendered = renderMergedLcov(merged);
  writeFileSync(values.output, rendered);
  console.log(`merge-lcov: ${positionals.length} shard(s), ${merged.size} source record(s) -> ${values.output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`merge-lcov: ${error.message}`);
    process.exitCode = 1;
  }
}
