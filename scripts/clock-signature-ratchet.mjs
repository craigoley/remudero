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

function canStartRegex(previousSignificant) {
  return previousSignificant === "" || /^[([{=:;,!&|?+\-*%^~<>]$/.test(previousSignificant);
}

/** Replace comments with whitespace while keeping source-text census tokens in strings/templates. */
function maskComments(source) {
  const chars = [...source];

  function skipQuoted(start, quote) {
    let escaped = false;
    for (let i = start + 1; i < chars.length; i++) {
      const ch = chars[i];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) return i + 1;
    }
    return chars.length;
  }

  function skipRegex(start) {
    let escaped = false;
    let inClass = false;
    for (let i = start + 1; i < chars.length; i++) {
      const ch = chars[i];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        i++;
        while (i < chars.length && /[A-Za-z]/.test(chars[i])) i++;
        return i;
      }
    }
    return chars.length;
  }

  function skipTemplate(start) {
    for (let i = start + 1; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === "\\") i++;
      else if (ch === "`") return i + 1;
      else if (ch === "$" && chars[i + 1] === "{") i = scanCode(i + 2, true);
    }
    return chars.length;
  }

  function blankComment(start, end) {
    for (let i = start; i < end; i++) if (chars[i] !== "\n") chars[i] = " ";
  }

  function scanCode(start, stopAtBrace) {
    let previousSignificant = "";
    let braceDepth = 0;
    for (let i = start; i < chars.length; i++) {
      const ch = chars[i];
      const next = chars[i + 1] ?? "";
      if (stopAtBrace && ch === "}" && braceDepth === 0) return i;
      if (ch === "'" || ch === '"') {
        i = skipQuoted(i, ch) - 1;
        previousSignificant = ch;
        continue;
      }
      if (ch === "`") {
        i = skipTemplate(i) - 1;
        previousSignificant = ch;
        continue;
      }
      if (ch === "/" && next === "/") {
        const end = chars.indexOf("\n", i + 2);
        blankComment(i, end === -1 ? chars.length : end);
        i = (end === -1 ? chars.length : end) - 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        const close = source.indexOf("*/", i + 2);
        const end = close === -1 ? chars.length : close + 2;
        blankComment(i, end);
        i = end - 1;
        continue;
      }
      if (ch === "/" && canStartRegex(previousSignificant)) {
        i = skipRegex(i) - 1;
        previousSignificant = "/";
        continue;
      }
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
      if (!/\s/.test(ch)) previousSignificant = ch;
    }
    return chars.length;
  }

  scanCode(0, false);
  return chars.join("");
}

export function scanClockSignaturesFromText(text) {
  const code = maskComments(text);
  return {
    legacy: count(LEGACY_CLOCK_SHAPE, code),
    dateNow: count(DATE_NOW, code),
    newDate: count(NEW_DATE, code),
  };
}

export function scanClockSignatures(root) {
  const src = join(root, "src");
  const result = {};
  for (const file of listTsFiles(src)) {
    const text = readFileSync(file, "utf8");
    const row = scanClockSignaturesFromText(text);
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

export function main(argv, deps = {}) {
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
    if (readFileSync(baselinePath, "utf8") !== serialized) {
      (deps.writeFileSync ?? writeFileSync)(baselinePath, serialized, "utf8");
    }
  } catch (error) {
    const code = typeof error?.code === "string" ? `${error.code}: ` : "";
    console.error(`clock-signature-ratchet: could not write ${baselinePath}: ${code}${String(error?.message ?? error)}`);
    return 2;
  }
  console.log(`clock-signature-ratchet: recorded ${Object.keys(next).length} row(s)`);
  return 0;
}

if (process.argv[1]?.endsWith("clock-signature-ratchet.mjs")) process.exit(main(process.argv.slice(2)));
