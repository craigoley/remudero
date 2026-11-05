import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const root = REPO_ROOT;
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

test("Haiku 5.5 image pins the CLI declared by its actual locked SDK", () => {
  const sdk = json("node_modules/@anthropic-ai/claude-agent-sdk/package.json");
  const lock = json("package-lock.json");
  const image = json("deploy/package.json");
  const imageLock = json("deploy/package-lock.json");
  const manifest = json("package.json");
  const lockedSdk = lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"].version;
  assert.equal(manifest.dependencies["@anthropic-ai/claude-agent-sdk"], "^" + lockedSdk);
  assert.equal(sdk.version, lockedSdk, "the actual installed SDK must match the committed lock");
  assert.equal(typeof sdk.claudeCodeVersion, "string", "the SDK must declare its CLI identity");
  assert.ok(sdk.claudeCodeVersion.length > 0, "the SDK CLI identity must not be empty");
  assert.equal(image.dependencies["@anthropic-ai/claude-code"], sdk.claudeCodeVersion);
  assert.equal(imageLock.packages["node_modules/@anthropic-ai/claude-code"].version, sdk.claudeCodeVersion);
  assert.equal(imageLock.packages[""].dependencies["@anthropic-ai/claude-code"], sdk.claudeCodeVersion);
});

test("Haiku 5.5 installed SDK ships its named native CLI without authenticating", () => {
  const platform = process.platform === "linux" && (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime === undefined
    ? "linux-" + process.arch + "-musl" : process.platform + "-" + process.arch;
  const native = join(root, "node_modules/@anthropic-ai/claude-agent-sdk-" + platform, process.platform === "win32" ? "claude.exe" : "claude");
  assert.ok(existsSync(native), "the native platform package must really be installed");
  const sdk = json("node_modules/@anthropic-ai/claude-agent-sdk/package.json");
  const version = execFileSync(native, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 4096 });
  assert.equal(version.trim(), sdk.claudeCodeVersion + " (Claude Code)");
});
