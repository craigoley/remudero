import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

test("Haiku 5.5 image pins the CLI declared by its actual locked SDK", () => {
  const sdk = json("node_modules/@anthropic-ai/claude-agent-sdk/package.json");
  const lock = json("package-lock.json");
  const image = json("deploy/package.json");
  const imageLock = json("deploy/package-lock.json");
  assert.equal(lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"].version, "0.3.293");
  assert.equal(sdk.version, "0.3.293", "the actual installed SDK must match the committed lock");
  assert.equal(sdk.claudeCodeVersion, "2.1.293", "read CLI identity from SDK metadata, never infer it");
  assert.equal(image.dependencies["@anthropic-ai/claude-code"], sdk.claudeCodeVersion);
  assert.equal(imageLock.packages["node_modules/@anthropic-ai/claude-code"].version, sdk.claudeCodeVersion);
  assert.equal(imageLock.packages[""].dependencies["@anthropic-ai/claude-code"], sdk.claudeCodeVersion);
});

test("Haiku 5.5 installed SDK ships its named native CLI without authenticating", () => {
  const platform = process.platform === "linux" && process.report.getReport().header.glibcVersionRuntime === undefined
    ? "linux-" + process.arch + "-musl" : process.platform + "-" + process.arch;
  const native = join(root, "node_modules/@anthropic-ai/claude-agent-sdk-" + platform, process.platform === "win32" ? "claude.exe" : "claude");
  assert.ok(existsSync(native), "the native platform package must really be installed");
  const sdk = json("node_modules/@anthropic-ai/claude-agent-sdk/package.json");
  const version = execFileSync(native, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 4096 });
  assert.equal(version.trim(), sdk.claudeCodeVersion + " (Claude Code)");
});
