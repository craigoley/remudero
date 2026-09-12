import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildShellRoute, resolveConsoleSha } from "../src/lib/serve.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "deploy", "serve-container.sh");

/** A dry-run reaches launch assembly but must never create the dedicated checkout. */
function fakeDockerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3369-docker-`));
  const body = [
    "#!/usr/bin/env bash",
    'if [ "$1" = "inspect" ]; then',
    '  case "$*" in',
    '    *Destination*) printf "%s\\n" "$RMD_STATE_DIR" ;;',
    '    *) exit 0 ;;',
    "  esac",
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  writeFileSync(join(dir, "docker"), body + "\n");
  chmodSync(join(dir, "docker"), 0o755);
  return dir;
}

function runDry(opts: { stateDir: string; serveRepoDir: string }): { status: number | null; out: string } {
  const dockerDir = fakeDockerDir();
  try {
    const result = spawnSync("bash", [SCRIPT, "--dry-run"], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${dockerDir}:${process.env.PATH}`,
        RMD_STATE_DIR: opts.stateDir,
        RMD_SERVE_REPO_DIR: opts.serveRepoDir,
        RMD_SERVE_DOCKERENV_PATH: join(opts.stateDir, "not-a-container"),
        GH_TOKEN: "synthetic-token-never-used",
      },
    });
    return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(dockerDir, { recursive: true, force: true });
  }
}

test("loaded console code identity ignores mutable cwd", () => {
  const nonRepo = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3369-non-repo-`));
  const previousCwd = Object.getOwnPropertyDescriptor(process, "cwd");
  let resolvedFrom = "";
  try {
    Object.defineProperty(process, "cwd", { ...previousCwd, value: () => nonRepo });
    assert.equal(
      resolveConsoleSha((dir) => {
        resolvedFrom = dir;
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      }),
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.equal(resolvedFrom, REPO_ROOT);
  } finally {
    Object.defineProperty(process, "cwd", previousCwd!);
    rmSync(nonRepo, { recursive: true, force: true });
  }
});

test("stale loaded code remains readable", () => {
  const route = buildShellRoute(undefined as never, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {}, undefined, () => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  let body = "";
  route.handler({} as never, { writeHead: () => {}, end: (html: string) => (body = html) } as never, {} as never);
  assert.match(body, /STALE — serving aaaaaaaaaaaa while the checkout reads bbbbbbbbbbbb/);
  assert.match(body, /loaded code/);
});

test("off main loaded code still serves", () => {
  const route = buildShellRoute(undefined as never, "cccccccccccccccccccccccccccccccccccccccc", {}, undefined, () => "cccccccccccccccccccccccccccccccccccccccc");
  let body = "";
  route.handler({} as never, { writeHead: () => {}, end: (html: string) => (body = html) } as never, {} as never);
  assert.match(body, /loaded code/);
  assert.match(body, /console-code-current/);
});

test("dedicated checkout overlays daemon checkout", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3369-state-`));
  const serveRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3369-serve-`));
  const serveRepo = join(serveRoot, "remudero");
  try {
    const result = runDry({ stateDir: stateRoot, serveRepoDir: serveRepo });
    assert.equal(result.status, 0, result.out);
    assert.ok(result.out.includes(`-v ${serveRepo}:/home/node/Remudero/remudero`));
    assert.match(result.out, /-e RMD_CONSOLE_BUILD_ROOT=\/home\/node\/Remudero\/remudero\/apps\/dashboard\/dist/);
    assert.ok(result.out.includes(`-v ${stateRoot}:/home/node/Remudero`));
    assert.equal(existsSync(serveRepo), false, "dry-run must not create the dedicated checkout");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(serveRoot, { recursive: true, force: true });
  }
});

test("W1-T3369: serve refuses an override that names the daemon checkout", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t3369-state-`));
  const daemonRepo = join(root, "remudero");
  try {
    mkdirSync(daemonRepo, { recursive: true });
    const result = runDry({ stateDir: root, serveRepoDir: daemonRepo });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /serve code directory is the daemon checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
