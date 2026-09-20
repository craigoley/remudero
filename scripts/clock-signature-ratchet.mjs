#!/usr/bin/env node
// Record and ratchet the clock-signature census without hand-editing its JSON ledger.
// The census remains the policy check; this companion only measures the current tree and
// records the exact rows it observed.  It deliberately refuses unreadable trees.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_BASELINE_RELATIVE_PATH = "scripts/clock-signature-baseline.json";
const LEGACY_CLOCK_SHAPE = /\bnow\??:\s*\(\)\s*=>\s*(?:number|string|Date)\b(?!\s*[.(])/g;
const DATE_NOW = /\bDate\.now\(\)/g;
const NEW_DATE = /\bnew Date\(/g;

function listTsFiles(dir) {
  const out = [];
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function count(re, text) {
  return text.match(re)?.length ?? 0;
}

export function scanClockSignatures(root) {
  const src = join(root, "src");
  const result = {};
  for (const file of listTsFiles(src)) {
    const text = readFileSync(file, "utf8");
    const row = {
      legacy: count(LEGACY_CLOCK_SHAPE, text),
      dateNow: count(DATE_NOW, text),
      newDate: count(NEW_DATE, text),
    };
    if (row.legacy || row.dateNow || row.newDate) {
      result[relative(root, file).split(sep).join("/")] = row;
    }
  }
  return result;
}

export function readBaseline(text, path = "clock-signature-baseline.json") {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`clock-signature-ratchet: ${path} is not valid JSON: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`clock-signature-ratchet: ${path} must be a JSON object`);
  }
  return parsed;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", default: "." },
      baseline: { type: "string" },
      check: { type: "boolean", default: false },
      "no-record": { type: "boolean", default: false },
    },
  });
  const root = resolve(values.root);
  const baselinePath = resolve(values.baseline ?? join(root, DEFAULT_BASELINE_RELATIVE_PATH));
  let current;
  let baseline;
  try {
    current = scanClockSignatures(root);
    baseline = readBaseline(readFileSync(baselinePath, "utf8"), baselinePath);
  } catch (error) {
    console.error(`clock-signature-ratchet: measurement failed: ${String(error?.message ?? error)}`);
    return 2;
  }

  const next = { ...current };
  const drift = [];
  const keys = new Set([...Object.keys(current), ...Object.keys(baseline).filter((key) => key !== "_comment")]);
  for (const key of [...keys].sort()) {
    const row = current[key];
    const old = baseline[key];
    if (!row) continue;
    if (!old || row.legacy > (old.legacy ?? 0) || row.dateNow > (old.dateNow ?? 0) || row.newDate > (old.newDate ?? 0)) {
      drift.push({ key, row, old });
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(Object.fromEntries(Object.entries(baseline).filter(([k]) => k !== "_comment")));
  if (values.check || values["no-record"]) {
    if (changed) {
      console.error(`clock-signature-ratchet: CHECK FAILED -- ${drift.length} growth/new row change(s) require recording`);
      for (const item of drift) console.error(`  ${item.key}: ${JSON.stringify(item.row)}`);
      return 1;
    }
    console.log("clock-signature-ratchet: OK");
    return 0;
  }

  try {
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (readFileSync(baselinePath, "utf8") !== serialized) writeFileSync(baselinePath, serialized);
  } catch (error) {
    console.error(`clock-signature-ratchet: could not write ${baselinePath}: ${String(error?.message ?? error)}`);
    return 2;
  }
  console.log(`clock-signature-ratchet: recorded ${Object.keys(next).length} row(s)`);
  return 0;
}

if (process.argv[1]?.endsWith("clock-signature-ratchet.mjs")) process.exit(main(process.argv.slice(2)));
