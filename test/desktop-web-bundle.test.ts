import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// ── W3-T3: the desktop (Tauri macOS shell) web-bundle build + drift gate (MASTER-PLAN §7) ──────
//
// §7 shell 1's acceptance criterion: "the web build is UNMODIFIED (same artifact, different
// shell)" -- proof: "the web bundle shipped in the Tauri shell is byte-identical to the shell-0
// build (same hash)." scripts/build-desktop-web.mjs is that copy-plus-proof step; this suite
// proves it ACTIVE, not merely present: a fresh build copies shell 0's two source files
// byte-for-byte into apps/desktop/dist and `--check` turns green; an edited (forked) bundled copy,
// or a shell-0 source file that changed after the bundle was built, turns `--check` RED and names
// the drifted file -- same falsifier discipline as test/no-hand-rolled-fetch-check.test.ts /
// test/plan-index.test.ts for their own sibling `--check` gates.
//
// `--skip-compile` is used throughout so this suite plants its own fixture source/output trees
// instead of driving a real repo-wide `tsc` compile (that compile path itself is exercised for
// real by the `npm run build` step CI already runs elsewhere).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "build-desktop-web.mjs");

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function mkFixtureRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "desktop-web-bundle-"));
  const dashboardDir = join(repoRoot, "apps", "dashboard");
  const compiledDir = join(repoRoot, "dist", "apps", "dashboard", "src");
  mkdirSync(dashboardDir, { recursive: true });
  mkdirSync(compiledDir, { recursive: true });
  writeFileSync(join(dashboardDir, "index.html"), "<!doctype html><html><body>shell 0</body></html>\n");
  writeFileSync(join(compiledDir, "main.js"), "export function boot() { /* shell 0 */ }\n");
  return repoRoot;
}

test("build-desktop-web: copies the shell-0 web build byte-for-byte into the out dir, with a source-hash manifest", () => {
  const repoRoot = mkFixtureRepo();
  const outDir = join(repoRoot, "apps", "desktop", "dist");
  try {
    const result = run("--repo-root", repoRoot, "--out-dir", outDir, "--skip-compile");
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const copiedHtml = readFileSync(join(outDir, "index.html"), "utf8");
    const copiedJs = readFileSync(join(outDir, "main.js"), "utf8");
    assert.equal(copiedHtml, readFileSync(join(repoRoot, "apps", "dashboard", "index.html"), "utf8"));
    assert.equal(copiedJs, readFileSync(join(repoRoot, "dist", "apps", "dashboard", "src", "main.js"), "utf8"));

    const manifest = JSON.parse(readFileSync(join(outDir, ".source-manifest.json"), "utf8"));
    assert.ok(manifest["index.html"].sha256);
    assert.ok(manifest["main.js"].sha256);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("build-desktop-web --check: a freshly built bundle is byte-identical -- exit 0, reports clean", () => {
  const repoRoot = mkFixtureRepo();
  const outDir = join(repoRoot, "apps", "desktop", "dist");
  try {
    assert.equal(run("--repo-root", repoRoot, "--out-dir", outDir, "--skip-compile").status, 0);
    const result = run("--repo-root", repoRoot, "--out-dir", outDir, "--skip-compile", "--check");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /clean/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("build-desktop-web --check: a hand-edited (forked) bundled copy -> exit 1, names the file and both hashes", () => {
  const repoRoot = mkFixtureRepo();
  const outDir = join(repoRoot, "apps", "desktop", "dist");
  try {
    assert.equal(run("--repo-root", repoRoot, "--out-dir", outDir, "--skip-compile").status, 0);
    writeFileSync(join(outDir, "main.js"), "export function boot() { /* FORKED for the Tauri shell */ }\n");

    const result = run("--repo-root", repoRoot, "--out-dir", outDir, "--skip-compile", "--check");
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /main\.js/);
    assert.match(output, /HASH MISMATCH/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("build-desktop-web --check: shell-0 source changed after the bundle was built -> exit 1, names the drifted file", () => {
  const repoRoot = mkFixtureRepo();
  const outDir = join(repoRoot, "apps", "desktop", "dist");
  try {
    assert.equal(run("--repo-root", repoRoot, "--out-dir", outDir, "--skip-compile").status, 0);
    writeFileSync(join(repoRoot, "apps", "dashboard", "index.html"), "<!doctype html><html><body>shell 0 v2</body></html>\n");

    const result = run("--repo-root", repoRoot, "--out-dir", outDir, "--skip-compile", "--check");
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /index\.html/);
    assert.match(output, /HASH MISMATCH/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("build-desktop-web --check: a missing bundle (never built) -> exit 1, names each missing file", () => {
  const repoRoot = mkFixtureRepo();
  const outDir = join(repoRoot, "apps", "desktop", "dist");
  try {
    const result = run("--repo-root", repoRoot, "--out-dir", outDir, "--skip-compile", "--check");
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /bundled copy missing/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
