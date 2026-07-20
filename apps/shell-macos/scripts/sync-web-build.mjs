#!/usr/bin/env node
// apps/shell-macos/scripts/sync-web-build.mjs
//
// Copies the shell-0 web build (apps/dashboard) into apps/shell-macos/web-dist/ -- BYTE-FOR-BYTE,
// no transform -- so Tauri's `frontendDist` packages the IDENTICAL artifact shell 0 ships
// (MASTER-PLAN §7: "the same web build IS the SAME artifact in every shell"; "a small delta over
// shell 0" -- the shell adds native affordances, it never forks the web code). This is what makes
// W3-T3's second acceptance claim checkable: run this script, then `shasum -a 256` the source
// files and the copies -- the hashes must match exactly. See this task's PR body for a pasted
// proof.
//
// Run `npm run build` at the REPO ROOT first (plain `tsc`, no bundler -- apps/dashboard has no
// build tooling of its own by design, the W3-T2 decision; see apps/dashboard/index.html's header
// comment). This script only copies dist/apps/dashboard's compiled output; it does not compile
// anything itself.
//
// Also copies dist/packages/api-client/src/client.js as a SIBLING file, `api-client.js` --
// apps/dashboard/index.html's import map (W3-T3 fix round) resolves main.js's bare specifier
// `@remudero/api-client/client` to exactly that relative path. client.js has zero runtime
// imports of its own (its only import is `import type`, elided by tsc), so this one file is
// the whole dependency -- no further resolution needed. Shell 0's own future static-serving
// wiring (apps/dashboard/index.html's header comment) needs the same sibling-copy step.
//
// web-dist/ is a build artifact (git-ignored), never a second source of truth for the web app.

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = join(here, ".."); // apps/shell-macos
const repoRoot = join(shellRoot, "..", ".."); // repo root
const dashboardSrc = join(repoRoot, "apps", "dashboard");
const compiledMain = join(repoRoot, "dist", "apps", "dashboard", "src", "main.js");
const compiledApiClient = join(repoRoot, "dist", "packages", "api-client", "src", "client.js");
const outDir = join(shellRoot, "web-dist");

const sourceIndexHtml = join(dashboardSrc, "index.html");

const required = [
  { label: "apps/dashboard/index.html", path: sourceIndexHtml },
  {
    label: "dist/apps/dashboard/src/main.js -- run `npm run build` at the repo root first",
    path: compiledMain,
  },
  {
    label: "dist/packages/api-client/src/client.js -- run `npm run build` at the repo root first",
    path: compiledApiClient,
  },
];

for (const { label, path } of required) {
  if (!existsSync(path)) {
    console.error(`sync-web-build: missing ${label} (expected at ${path})`);
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });
copyFileSync(sourceIndexHtml, join(outDir, "index.html"));
copyFileSync(compiledMain, join(outDir, "main.js"));
copyFileSync(compiledApiClient, join(outDir, "api-client.js"));

console.log(
  `sync-web-build: copied apps/dashboard's unmodified index.html + compiled main.js + api-client.js -> ${outDir}`,
);
