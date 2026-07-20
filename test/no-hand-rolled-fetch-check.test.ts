import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// ── W3-T1c: no-hand-rolled-fetch grep gate (MASTER-PLAN §7A) ────────────────────────────────
//
// §7A: "No client may hand-roll a `fetch` to the daemon -- a grep gate fails the build (W3-T1)."
// This suite proves scripts/no-hand-rolled-fetch-check.mjs is ACTIVE, not merely present: a
// planted `fetch(`/`axios.<method>(`/`new XMLHttpRequest` call turns it RED and names the
// file:line; a clean consumer (or an empty/nonexistent client directory) turns it GREEN; and
// `packages/api-client` itself is excluded (the one sanctioned place a future runtime HTTP layer
// for the generated client may live) while sibling packages are NOT -- same falsifier discipline
// as test/api-client-drift-check.test.ts / test/strict-probe.test.ts, driving the real CLI as a
// subprocess (this script is a plain .mjs file outside tsconfig's `include`).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "no-hand-rolled-fetch-check.mjs");

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

function mkTmp() {
  return mkdtempSync(join(tmpdir(), "no-hand-rolled-fetch-"));
}

test("no-hand-rolled-fetch: a clean consumer file (no fetch/axios/XHR) -> exit 0, reports clean", () => {
  const tmp = mkTmp();
  try {
    const appDir = join(tmp, "apps", "dashboard", "src");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "state.ts"),
      `import type { components } from "@remudero/api-client";\nexport type State = components["schemas"]["Error"];\n`,
    );
    const result = run("--dir", join(tmp, "apps"));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /clean/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no-hand-rolled-fetch: a bare fetch( call -> exit 1, names the file:line", () => {
  const tmp = mkTmp();
  try {
    const appDir = join(tmp, "apps", "dashboard", "src");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "state.ts"), `export async function load() {\n  return fetch("https://daemon.example/state");\n}\n`);
    const result = run("--dir", join(tmp, "apps"));
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /state\.ts:2:/);
    assert.match(output, /fetch\(\.\.\.\)/);
    assert.match(output, /@remudero\/api-client/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no-hand-rolled-fetch: axios.get(...) -> exit 1", () => {
  const tmp = mkTmp();
  try {
    const appDir = join(tmp, "apps", "dashboard", "src");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "state.ts"), `import axios from "axios";\nexport const load = () => axios.get("/state");\n`);
    const result = run("--dir", join(tmp, "apps"));
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /axios/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no-hand-rolled-fetch: new XMLHttpRequest -> exit 1", () => {
  const tmp = mkTmp();
  try {
    const appDir = join(tmp, "apps", "dashboard", "src");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "state.ts"), `export const req = new XMLHttpRequest();\n`);
    const result = run("--dir", join(tmp, "apps"));
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /XMLHttpRequest/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no-hand-rolled-fetch: packages/api-client is EXCLUDED (sanctioned client); a sibling package is NOT", () => {
  const tmp = mkTmp();
  try {
    const apiClientDir = join(tmp, "packages", "api-client", "src");
    const siblingDir = join(tmp, "packages", "other-pkg", "src");
    mkdirSync(apiClientDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(apiClientDir, "http.ts"), `export const raw = () => fetch("https://daemon.example");\n`);
    writeFileSync(join(siblingDir, "index.ts"), `export const raw = () => fetch("https://daemon.example");\n`);

    const result = run("--dir", join(tmp, "packages"));
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /other-pkg\/src\/index\.ts/);
    assert.doesNotMatch(output, /api-client\/src\/http\.ts/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no-hand-rolled-fetch: a client directory that does not exist yet (apps/ before W3-T2) is CLEAN, not an error", () => {
  const tmp = mkTmp();
  try {
    const result = run("--dir", join(tmp, "apps"));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /clean/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no-hand-rolled-fetch: the REAL repo (default dirs, no --dir) is clean today", () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /clean/);
});
