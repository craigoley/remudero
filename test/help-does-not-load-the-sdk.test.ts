import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rmdBin = join(repoRoot, "bin", "rmd");
const recorder = join(repoRoot, "test", "helpers", "module-load-recorder.cjs");

function recorderEnv(logPath: string): NodeJS.ProcessEnv {
  const nodeOptions = [process.env.NODE_OPTIONS, "--require", recorder].filter(Boolean).join(" ");
  return {
    ...process.env,
    GH_TOKEN: process.env.GH_TOKEN ?? "module-load-recorder-test-token",
    NODE_OPTIONS: nodeOptions,
    RMD_MODULE_LOAD_LOG: logPath,
    RMD_SELF_SYNC_DONE: "1",
  };
}

function loadedModules(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("rmd --help does not load the Claude SDK, Playwright, or daemon module", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-help-loads-"));
  try {
    const helpLog = join(dir, "help.log");
    const out = execFileSync(rmdBin, ["--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: recorderEnv(helpLog),
    });
    assert.match(out, /^usage:/);
    const helpLoads = loadedModules(helpLog).join("\n");
    assert.doesNotMatch(helpLoads, /node_modules\/@anthropic-ai\/claude-agent-sdk\//);
    assert.doesNotMatch(helpLoads, /node_modules\/(?:playwright|playwright-core)\//);
    assert.doesNotMatch(helpLoads, /src\/lib\/daemon\.ts$/m);

    const doctorLog = join(dir, "doctor.log");
    spawnSync(rmdBin, ["doctor"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: recorderEnv(doctorLog),
    });
    assert.match(
      loadedModules(doctorLog).join("\n"),
      /src\/lib\/daemon\.ts$/m,
      "control: the recorder must see daemon.ts when a normal rmd verb loads run-task.ts",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
