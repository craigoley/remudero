import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..");
const SELF_SYNC_IMPORT = pathToFileURL(join(REPO_ROOT, "src", "lib", "self-sync.ts")).href;

function gitFixture(): { originDir: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-reexec-signal-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(originDir, { recursive: true });
  const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "--quiet", "-b", "main", originDir]);
  git(originDir, ["config", "user.email", "test@example.invalid"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "seed.txt"), "one\n");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "test@example.invalid"]);
  git(localDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "published.txt"), "published\n");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "published"]);
  return { originDir, localDir };
}

function writeHarnessScript(dir: string): string {
  const scriptPath = join(dir, "reexec-parent.ts");
  writeFileSync(
    scriptPath,
    `
import { writeFileSync } from "node:fs";
import { checkCliFreshness, SELF_SYNC_GUARD_ENV } from ${JSON.stringify(SELF_SYNC_IMPORT)};

const markerDir = process.env.RMD_REEXEC_MARKER_DIR;
const localDir = process.env.RMD_REEXEC_LOCAL_DIR;
if (!markerDir || !localDir) throw new Error("missing re-exec fixture env");

function mark(name, body = String(process.pid)) {
  writeFileSync(markerDir + "/" + name, body);
}

if (process.env[SELF_SYNC_GUARD_ENV] === "1") {
  mark("child-ready");
  process.on("SIGTERM", () => {
    mark("child-sigterm");
    process.exit(Number(process.env.RMD_REEXEC_SIGNAL_EXIT_CODE ?? "42"));
  });
  setTimeout(
    () => process.exit(Number(process.env.RMD_REEXEC_CHILD_EXIT_CODE ?? "23")),
    Number(process.env.RMD_REEXEC_CHILD_DELAY_MS ?? "50"),
  );
} else {
  const result = checkCliFreshness(localDir, process.env, {
    say: () => {},
    warn: (msg) => mark("parent-warning", msg),
    log: () => {},
  });
  mark("parent-returned", JSON.stringify(result));
}
`,
    "utf8",
  );
  return scriptPath;
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  delete env.RMD_SELF_SYNC_DONE;
  return env;
}

function spawnParent(scriptPath: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 8_000,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out waiting for re-exec parent; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once("exit", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function killIfAlive(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already exited
  }
}

test("default re-exec passes through the fresh child's ordinary exit code", async () => {
  const { localDir } = gitFixture();
  const markerDir = mkdtempSync(join(tmpdir(), "rmd-reexec-markers-"));
  const scriptPath = writeHarnessScript(markerDir);
  const parent = spawnParent(
    scriptPath,
    cleanEnv({
      RMD_REEXEC_LOCAL_DIR: localDir,
      RMD_REEXEC_MARKER_DIR: markerDir,
      RMD_REEXEC_CHILD_EXIT_CODE: "23",
      RMD_REEXEC_CHILD_DELAY_MS: "25",
    }),
  );

  try {
    const result = await waitForExit(parent);
    assert.equal(result.status, 23, `stdout=${result.stdout}; stderr=${result.stderr}`);
    assert.equal(result.signal, null);
    assert.ok(existsSync(join(markerDir, "child-ready")), "the guarded child really ran");
    assert.ok(!existsSync(join(markerDir, "child-sigterm")), "the no-signal control must stay ordinary");
  } finally {
    killIfAlive(join(markerDir, "child-ready"));
  }
});

test("default re-exec forwards SIGTERM to the fresh child and exits with the child's status", async () => {
  const { localDir } = gitFixture();
  const markerDir = mkdtempSync(join(tmpdir(), "rmd-reexec-markers-"));
  const scriptPath = writeHarnessScript(markerDir);
  const parent = spawnParent(
    scriptPath,
    cleanEnv({
      RMD_REEXEC_LOCAL_DIR: localDir,
      RMD_REEXEC_MARKER_DIR: markerDir,
      RMD_REEXEC_CHILD_DELAY_MS: "5000",
      RMD_REEXEC_SIGNAL_EXIT_CODE: "42",
    }),
  );

  try {
    await waitForFile(join(markerDir, "child-ready"));
    parent.kill("SIGTERM");
    const result = await waitForExit(parent);
    assert.equal(result.status, 42, `stdout=${result.stdout}; stderr=${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(
      await waitForFile(join(markerDir, "child-sigterm")),
      readFileSync(join(markerDir, "child-ready"), "utf8"),
      "the signal marker must be written by the re-exec child itself",
    );
  } finally {
    killIfAlive(join(markerDir, "child-ready"));
  }
});
