#!/usr/bin/env node
// scripts/ledger-steps-check.mjs
//
// THE LEDGER-STEP RATCHET (W1-T2764). `LedgerLine.step` (src/lib/ledger.ts) is a free string,
// written ad hoc across ~180 files under src/, with no registry until this task's
// src/lib/ledger-steps.ts. A daemon that REFUSED to append a line on an unregistered step would
// fail on its first new step in production -- a bound firing on a healthy condition, this repo's
// recurring defect (claude-md-budget-ratchet/task-id-existence-check's own rationale). This gate
// takes the ratchet shape instead: every step literal found under src/ must resolve to EITHER a
// registered row in LEDGER_STEPS OR a written, reasoned exemption in
// scripts/ledger-steps-baseline.json (the task-id-existence-check.mjs shape -- an entry with no
// reason is REJECTED, so the exemption list cannot grow silently). A literal that resolves to
// neither FAILS the ratchet BY NAME.
//
// SHRINK-ONLY. The baseline is not a count to raise; it is a list of literals nobody has decoded
// yet. The only way this population falls is registering a literal in LEDGER_STEPS (moving it OUT
// of the baseline and INTO the registry, with a real writer + outcome read) or deleting the dead
// code that logs it. Adding a baseline entry for a literal that is not already exempt requires a
// written reason a reviewer reads -- exactly like task-id-existence-check.mjs's own baseline.
//
// TWO LITERAL FORMS, MATCHING recon's OWN CENSUS METHODOLOGY (so this gate's count is the same
// count the task was filed against): `log("<dotted.step>"` / `ctx.log("<dotted.step>"` call-site
// literals, and `step: "<dotted.step>"` object/type literals. Both are ANCHORED to a
// lowercase-dotted literal immediately following the marker -- a computed/ternary step name (e.g.
// `armSkipStepName`'s indirect return) is invisible to this census by construction, the same
// undercount this repo's own `log(\"...\")`/`step: \"...\"` grep already carries; see
// src/lib/ledger-steps.ts's own doc for two named examples (`automerge.arm_failed`,
// `automerge.disarm_skipped`).
//
// Usage: node scripts/ledger-steps-check.mjs [--dir <path>]... [--baseline <path>]
//   [--registry <path>] [--cwd <path>]. Defaults: src; scripts/ledger-steps-baseline.json;
//   src/lib/ledger-steps.ts.
//
// Exported pure pieces let the fixture test drive the scanner and the evaluator independently of
// this file's own real-tree numbers; `main` is exported so the CLI itself (argv parse, exit code)
// is provable too -- same discipline as task-id-existence-check.mjs.

import { readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { join, relative } from "node:path";

const LOG_CALL_STEP_RE = /\blog\(\s*"([a-z_]+(?:\.[a-z_]+)+)"/g;
const STEP_FIELD_RE = /\bstep:\s*"([a-z_]+(?:\.[a-z_]+)+)"/g;
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "build", ".git", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".mjs", ".js"]);

function walkFiles(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return; // nothing to scan -- not an error.
    throw err;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkFiles(abs, files);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot);
      if (SOURCE_EXTENSIONS.has(ext)) files.push(abs);
    }
  }
}

/**
 * Scan `dirs` (resolved against `cwd`) for every step literal either marker form matches,
 * returning step -> the list of `{ file, line }` occurrences (file relative to `cwd`) -- so a
 * failure names a concrete pointer, not just a bare literal. Read-only, matches
 * task-id-existence-check.mjs's own `scanCitedIds` shape.
 */
export function scanStepLiterals(dirs, cwd) {
  const hits = new Map();
  const record = (step, file, line) => {
    if (!hits.has(step)) hits.set(step, []);
    hits.get(step).push({ file, line });
  };
  for (const dir of dirs) {
    const files = [];
    walkFiles(join(cwd, dir), files);
    for (const abs of files) {
      const rel = relative(cwd, abs);
      const text = readFileSync(abs, "utf8");
      const lines = text.split("\n");
      lines.forEach((lineText, idx) => {
        LOG_CALL_STEP_RE.lastIndex = 0;
        let m;
        while ((m = LOG_CALL_STEP_RE.exec(lineText)) !== null) record(m[1], rel, idx + 1);
        STEP_FIELD_RE.lastIndex = 0;
        while ((m = STEP_FIELD_RE.exec(lineText)) !== null) record(m[1], rel, idx + 1);
      });
    }
  }
  return hits;
}

/** Parse+validate scripts/ledger-steps-baseline.json into a Map from step to its written reason.
 *  THROWS on a structurally invalid file or any entry missing a non-empty `reason` -- a
 *  silently-growable exemption list is exactly what this gate exists to prevent for itself.
 *  Mirrors task-id-existence-check.mjs's own `loadBaseline`. */
export function loadBaseline(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`ledger-steps-check: cannot read baseline file ${path}: ${err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`ledger-steps-check: ${path} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(doc)) {
    throw new Error(`ledger-steps-check: ${path} must be a JSON array of { step, reason } entries`);
  }
  const map = new Map();
  doc.forEach((entry, idx) => {
    const step = entry && typeof entry.step === "string" ? entry.step : null;
    if (!step) {
      throw new Error(`ledger-steps-check: ${path}[${idx}] has no valid "step": ${JSON.stringify(entry)}`);
    }
    const reason = entry && typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (reason === "") {
      throw new Error(
        `ledger-steps-check: ${path}[${idx}] (${step}) has NO WRITTEN REASON -- a baseline entry with no ` +
          `recorded reason is rejected, so the exemption list cannot grow silently.`,
      );
    }
    if (map.has(step)) {
      throw new Error(`ledger-steps-check: ${path} lists ${step} more than once`);
    }
    map.set(step, reason);
  });
  return map;
}

/**
 * Pure decision layer: classify every found step literal as "registered" (a row in
 * `registeredSteps`), "baselined" (a written exemption) or "failed" (neither -- an unregistered
 * literal this ratchet refuses). Mirrors task-id-existence-check.mjs's `evaluateIds` shape.
 */
export function evaluateSteps(foundHits, registeredSteps, baseline) {
  const results = [];
  for (const [step, occurrences] of foundHits) {
    if (registeredSteps.has(step)) {
      results.push({ step, status: "registered", occurrences });
    } else if (baseline.has(step)) {
      results.push({ step, status: "baselined", occurrences, reason: baseline.get(step) });
    } else {
      results.push({ step, status: "failed", occurrences });
    }
  }
  return results;
}

/**
 * Exported so its own suite can cover the CLI in-process -- a subprocess's coverage is not the
 * parent run's. Unchanged behaviour: the direct-execution guard at file end decides whether
 * `main` runs, and it communicates via `process.exitCode`, so an in-process caller must save and
 * restore it -- same convention as task-id-existence-check.mjs's own `main`.
 */
export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", multiple: true },
      baseline: { type: "string", default: "scripts/ledger-steps-baseline.json" },
      registry: { type: "string", default: "src/lib/ledger-steps.ts" },
      cwd: { type: "string" },
    },
  });

  const cwd = values.cwd ?? process.cwd();
  const dirs = values.dir && values.dir.length > 0 ? values.dir : ["src"];

  let baseline;
  try {
    baseline = loadBaseline(values.baseline);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  // Read the registry as TEXT, not an import -- this script runs outside tsconfig's build (same
  // convention as generate-cli-reference.mjs importing COMMANDS only under `tsx`), and the CLI
  // path here has no need of anything beyond the literal `step: "..."` this file's own rows
  // carry. STEP_FIELD_RE (this module's own scanner) reads the registry file with itself, so
  // there is exactly one definition of "what a step literal looks like", not two.
  let registryText;
  try {
    registryText = readFileSync(join(cwd, values.registry), "utf8");
  } catch (err) {
    console.error(`ledger-steps-check: cannot read registry file ${values.registry}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const registeredSteps = new Set();
  STEP_FIELD_RE.lastIndex = 0;
  let rm;
  while ((rm = STEP_FIELD_RE.exec(registryText)) !== null) registeredSteps.add(rm[1]);

  const foundHits = scanStepLiterals(dirs, cwd);
  const results = evaluateSteps(foundHits, registeredSteps, baseline);
  const failed = results.filter((r) => r.status === "failed").sort((a, b) => a.step.localeCompare(b.step));
  const registered = results.filter((r) => r.status === "registered");
  const baselined = results.filter((r) => r.status === "baselined");

  if (failed.length > 0) {
    console.error(
      `\nledger-steps-check: FAILED -- the following step literal(s) are cited under ${dirs.join(", ")} but ` +
        `resolve to NEITHER a registered row in ${values.registry} NOR a written baseline exemption:\n`,
    );
    for (const r of failed) {
      console.error(`  ${r.step}`);
      for (const occ of r.occurrences) console.error(`    ${occ.file}:${occ.line}`);
    }
    console.error(
      `\nEither register it in ${values.registry}'s LEDGER_STEPS (name its meaning, its writer, and the ` +
        `outcomes that writer can return) or add it to ${values.baseline} with a written reason. Never ` +
        "rename the literal itself -- DECISIONS.md (2026-08-15) treats a ledger step name as a query key.\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `ledger-steps-check: OK -- every step literal cited under ${dirs.join(", ")} resolves to a registered row ` +
      `(${registered.length}) or a baselined exemption (${baselined.length}).`,
  );
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/ledger-steps-check.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
