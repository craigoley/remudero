#!/usr/bin/env node
// scripts/no-hand-rolled-fetch-check.mjs
//
// NO-HAND-ROLLED-FETCH GREP GATE (W3-T1c, MASTER-PLAN §7A).
//
// §7A: "packages/api-client is GENERATED from that surface [openapi/daemon.yaml]... and is the
// ONLY way any client talks to the daemon... No client may hand-roll a `fetch` to the daemon --
// a grep gate fails the build (W3-T1)." This script IS that gate: it walks a set of CLIENT
// directories (default: `apps` -- the future dashboard/desktop/mobile shells, MASTER-PLAN §7 --
// and `packages`) and fails loudly if any scanned source file contains a direct `fetch(`,
// `axios(...)`/`axios.<method>(...)`, or `new XMLHttpRequest` call. `packages/api-client` itself
// is EXCLUDED from the scan -- it is the one sanctioned place a future runtime HTTP layer for the
// generated client is allowed to live; everything else under `packages` (and everything under
// `apps`) is a CONSUMER and must talk to the daemon only via `@remudero/api-client`.
//
// Usage:
//   node scripts/no-hand-rolled-fetch-check.mjs [--dir <path>]...
//   (no --dir) -> defaults to ["apps", "packages"], with packages/api-client excluded internally.
//
// Exits 0 ("clean") when zero matches are found across every scanned file -- INCLUDING when a
// scanned directory does not exist yet (apps/ is empty until W3-T2). That "nothing to scan yet"
// case is intentionally not an error (a client-less repo has nothing to violate the rule), but
// the gate's ACTIVENESS is proven separately by test/no-hand-rolled-fetch-check.test.ts's
// planted-fixture falsifiers, not by "it found nothing" alone -- same discipline as the strict-
// probe / api-client-drift falsifier tests this gate sits alongside.

import { readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const DEFAULT_DIRS = ["apps", "packages"];
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "build", ".git"]);
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]);

const FORBIDDEN_PATTERNS = [
  { name: "fetch(...)", regex: /\bfetch\s*\(/ },
  { name: "axios(...) / axios.<method>(...)", regex: /\baxios\s*[.(]/ },
  { name: "new XMLHttpRequest", regex: /\bnew\s+XMLHttpRequest\b/ },
];

/**
 * True if `relPath` passes through a `packages/api-client` directory anywhere along its walked
 * path -- checked as a consecutive PATH-SEGMENT pair (not a string prefix) so it matches
 * regardless of whether the walk root was given as "packages", "./packages", or an absolute path
 * ending in ".../packages".
 */
function isSanctionedApiClientPath(relPath) {
  const segments = relPath.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === "packages" && segments[i + 1] === "api-client") return true;
  }
  return false;
}

function walk(dir, relRoot, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return; // nothing to scan yet -- not an error.
    throw err;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = `${relRoot}/${entry.name}`;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      if (isSanctionedApiClientPath(rel)) continue;
      walk(abs, rel, files);
    } else if (entry.isFile()) {
      if (isSanctionedApiClientPath(rel)) continue;
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot);
      if (SCANNED_EXTENSIONS.has(ext)) files.push({ abs, rel });
    }
  }
}

/** Pure scan over already-resolved directory roots -- no process.exit, directly unit-testable. */
export function scan(dirs) {
  const files = [];
  for (const dir of dirs) walk(dir, dir, files);

  const violations = [];
  for (const { abs, rel } of files) {
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, idx) => {
      for (const { name, regex } of FORBIDDEN_PATTERNS) {
        if (regex.test(line)) {
          violations.push(`${rel}:${idx + 1}: hand-rolled ${name} -- talk to the daemon via @remudero/api-client instead`);
        }
      }
    });
  }
  return violations;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { dir: { type: "string", multiple: true } },
  });
  const dirs = values.dir && values.dir.length > 0 ? values.dir : DEFAULT_DIRS;

  const violations = scan(dirs);
  if (violations.length > 0) {
    console.error("no-hand-rolled-fetch: FAILED -- hand-rolled daemon call(s) found:");
    for (const v of violations) console.error(`  ${v}`);
    console.error("");
    console.error("MASTER-PLAN §7A: no client may hand-roll a fetch to the daemon -- import @remudero/api-client instead.");
    process.exitCode = 1;
    return;
  }
  console.log(`no-hand-rolled-fetch: clean -- no hand-rolled daemon calls found under [${dirs.join(", ")}].`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/no-hand-rolled-fetch-check.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
