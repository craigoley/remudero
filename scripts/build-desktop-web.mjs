#!/usr/bin/env node
// scripts/build-desktop-web.mjs
//
// DESKTOP WEB-BUNDLE builder + drift gate (W3-T3, MASTER-PLAN §7 shell 1).
//
// §7: "SHELL 1 — Tauri macOS (W3-T3). Wraps the same web build in a native shell... The web build
// is the identical artifact shell 0 ships — the shell adds native affordances, never forks the web
// code." W3-T3's own acceptance criterion requires proof of that: "the web bundle shipped in the
// Tauri shell is byte-identical to the shell-0 build (same hash)."
//
// This script IS that wrap-without-fork step, plus its own falsifier gate:
//   - (default) build: compile the repo via the SAME `tsc -p tsconfig.json` shell 0 already uses
//     (never a second, differently-configured compile path — a second compile path is exactly the
//     kind of fork this exists to catch), then copy the two files that make up the shell-0 web
//     build (apps/dashboard/index.html, unmodified; dist/apps/dashboard/src/main.js, tsc's own
//     output) into apps/desktop/dist -- the directory Tauri's `frontendDist` (src-tauri/tauri.conf.json)
//     points at. A `.source-manifest.json` alongside the copies records each file's sha256 at copy
//     time.
//   - `--check`: recompute both the CURRENT shell-0 source hashes and the CURRENT bundled-copy
//     hashes and fail loudly, naming every mismatched file, if they've drifted apart (e.g. someone
//     hand-edited apps/desktop/dist directly, or shell 0 changed and the shell wasn't rebuilt) --
//     same `--check` convention as scripts/generate-plan-index.mjs / generate-learnings-index.mjs.
//
// Usage:
//   node scripts/build-desktop-web.mjs [--repo-root <path>] [--out-dir <path>] [--skip-compile]
//   node scripts/build-desktop-web.mjs --check [--repo-root <path>] [--out-dir <path>] [--skip-compile]
//
// `--skip-compile` assumes dist/apps/dashboard/src/main.js already exists (e.g. a prior `npm run
// build`) and is exposed for tests that plant fixture source/output trees instead of driving a
// real (slow) repo-wide tsc compile.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const DEFAULT_REPO_ROOT = process.cwd();

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * The two files that make up shell 0's web build (MASTER-PLAN §7): the raw HTML shell (no compile
 * step — apps/dashboard/index.html loads its compiled output as a plain ES module, W3-T2's own
 * "no bundler by design" decision) and tsc's compiled entry point.
 */
function sourcePaths(repoRoot) {
  return {
    "index.html": join(repoRoot, "apps", "dashboard", "index.html"),
    "main.js": join(repoRoot, "dist", "apps", "dashboard", "src", "main.js"),
  };
}

function outputPaths(outDir) {
  return {
    "index.html": join(outDir, "index.html"),
    "main.js": join(outDir, "main.js"),
  };
}

/** Drive the repo's ONE existing build command -- never a second, differently-configured compile. */
function compile(repoRoot) {
  const result = spawnSync(process.execPath, [join(repoRoot, "node_modules", ".bin", "tsc"), "-p", "tsconfig.json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `build-desktop-web: \`tsc -p tsconfig.json\` failed (exit ${result.status ?? "signal " + result.signal}):\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
}

/**
 * Copy the current shell-0 web build into `outDir`, unmodified, plus a `.source-manifest.json`
 * recording each copied file's source path (relative to `repoRoot`) and sha256 at copy time.
 */
export function buildDesktopWebBundle({ repoRoot = DEFAULT_REPO_ROOT, outDir, skipCompile = false } = {}) {
  if (!outDir) throw new Error("buildDesktopWebBundle: outDir is required");
  if (!skipCompile) compile(repoRoot);

  const src = sourcePaths(repoRoot);
  for (const [name, path] of Object.entries(src)) {
    if (!existsSync(path)) {
      throw new Error(
        `buildDesktopWebBundle: missing shell-0 source file for "${name}" at ${path} -- run \`npm run build\` first, or apps/dashboard has moved`,
      );
    }
  }

  mkdirSync(outDir, { recursive: true });
  const out = outputPaths(outDir);
  const manifest = {};
  for (const key of Object.keys(src)) {
    const bytes = readFileSync(src[key]);
    writeFileSync(out[key], bytes);
    manifest[key] = { sourcePath: relative(repoRoot, src[key]), sha256: sha256(bytes) };
  }
  writeFileSync(join(outDir, ".source-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { outDir, manifest };
}

/**
 * Compare the CURRENT shell-0 source hashes against the CURRENT bundled-copy hashes in `outDir`.
 * Returns `{ ok: true }` when every file matches; otherwise `{ ok: false, mismatches: string[] }`
 * naming each drifted/missing file.
 */
export function verifyDesktopWebBundle({ repoRoot = DEFAULT_REPO_ROOT, outDir, skipCompile = false } = {}) {
  if (!outDir) throw new Error("verifyDesktopWebBundle: outDir is required");
  if (!skipCompile) compile(repoRoot);

  const src = sourcePaths(repoRoot);
  const out = outputPaths(outDir);
  const mismatches = [];
  for (const key of Object.keys(src)) {
    if (!existsSync(out[key])) {
      mismatches.push(`${key}: bundled copy missing at ${out[key]} -- run the build first`);
      continue;
    }
    if (!existsSync(src[key])) {
      mismatches.push(`${key}: shell-0 source missing at ${src[key]}`);
      continue;
    }
    const srcHash = sha256(readFileSync(src[key]));
    const outHash = sha256(readFileSync(out[key]));
    if (srcHash !== outHash) {
      mismatches.push(`${key}: HASH MISMATCH -- shell-0 source ${srcHash} != bundled copy ${outHash} (the Tauri shell has forked from the shell-0 web build)`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function main() {
  const { values } = parseArgs({
    options: {
      "repo-root": { type: "string" },
      "out-dir": { type: "string" },
      check: { type: "boolean", default: false },
      "skip-compile": { type: "boolean", default: false },
    },
  });
  const repoRoot = values["repo-root"] ? resolve(values["repo-root"]) : DEFAULT_REPO_ROOT;
  const outDir = values["out-dir"] ? resolve(values["out-dir"]) : join(repoRoot, "apps", "desktop", "dist");
  const skipCompile = values["skip-compile"];

  if (values.check) {
    const { ok, mismatches } = verifyDesktopWebBundle({ repoRoot, outDir, skipCompile });
    if (!ok) {
      console.error("build-desktop-web --check: FAILED -- the Tauri shell's bundled web build has drifted from shell 0:");
      for (const m of mismatches) console.error(`  - ${m}`);
      process.exitCode = 1;
      return;
    }
    console.log(`build-desktop-web --check: clean -- ${relative(repoRoot, outDir)} is byte-identical to the shell-0 build.`);
    return;
  }

  const { manifest } = buildDesktopWebBundle({ repoRoot, outDir, skipCompile });
  console.log(`build-desktop-web: wrote ${relative(repoRoot, outDir)} (${Object.keys(manifest).length} files, unmodified copies of the shell-0 web build)`);
  for (const [key, entry] of Object.entries(manifest)) {
    console.log(`  - ${key}: sha256 ${entry.sha256} (from ${entry.sourcePath})`);
  }
}

// Only run when executed directly (`node scripts/build-desktop-web.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
