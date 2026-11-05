// W1-T11437: a Codex writer's egress goes through Codex's allowlist proxy fed by the fleet's one allowlist,
// on both the legacy workspace path and the private-registry profile. Measured in-container on 2026-11-05:
// `sandbox_workspace_write.network_access=true` reached example.com at its real address, while a `:workspace`
// profile with `network.domains` and `--enable network_proxy` answered api.github.com through 127.0.0.1 and
// refused example.com with a 403 CONNECT, keeping the worktree writable and its git config protected.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import * as runtimeRegistry from "#src/lib/instance-registry-selection.js";
import { ALLOWED_NETWORK_DOMAINS } from "#src/lib/settings.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { codexNetworkDomains, spawnCodexWorker } from "#src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "#src/lib/worker-containment.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const BOUND = { timeout: 60_000 };

/** Whether `flag value` appears as an adjacent pair anywhere in the argv (Codex takes `--enable` more than once). */
function hasPair(args: readonly string[], flag: string, value: string): boolean {
  return args.some((arg, i) => arg === flag && args[i + 1] === value);
}

function finishingChild() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  stdin.on("finish", () => {
    stdout.end(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
    queueMicrotask(() => child.emit("exit", 0));
  });
  return child;
}

function legacyConfig(root: string) {
  return { claudeBin: "/unused/claude", root,
    workerProviders: { enabled: ["codex" as const], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome: join(root, "codex-home") } };
}

async function legacyArgs(root: string, tools: string[]): Promise<string[]> {
  const cwd = join(root, "worktree");
  execFileSync("git", ["init", "-q", "-b", "main", cwd]);
  let captured: ContainedSpawnOptions | undefined;
  const child = finishingChild();
  await spawnCodexWorker({
    workerHome: mkdtempSync(join(root, "home-")), cwd, prompt: "egress fixture",
    settingsFile: join(REPO_ROOT, "settings", "worker.json"), tools,
    containment: { spawn: (options) => { captured = options; return { process: child as never, pid: 11_437 }; }, teardown: () => {} },
  }, legacyConfig(root));
  assert.ok(captured, "the containment adapter received the Codex argv");
  return captured.args;
}

type RuntimeRegistryRunner = <T>(operation: () => T | Promise<T>, input: { envPath?: string; instanceName?: string }) => Promise<T>;
const runtimeRegistryRunner = (): RuntimeRegistryRunner => Reflect.get(runtimeRegistry, "withInstanceRegistryRuntime") as RuntimeRegistryRunner;

async function privateArgs(root: string, tools: string[]): Promise<{ args: string[]; profileText: string }> {
  const selected = join(root, ".config", "remudero", "selected-registry.yaml");
  mkdirSync(join(root, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, ".remudero"), { recursive: true });
  const registry = "instances:\n  worker:\n    github_repo: owner/repo\n    mode: live\n";
  writeFileSync(join(root, ".remudero", "daemon-instances.yaml"), registry);
  writeFileSync(selected, registry);
  const codexHome = join(root, "codex-home"), cwd = join(root, "checkout");
  mkdirSync(codexHome, { recursive: true }); mkdirSync(cwd, { recursive: true });
  let args: string[] = [], profileText = "";
  const child = finishingChild();
  await runtimeRegistryRunner()(() => spawnCodexWorker({
    cwd, workerHome: root, prompt: "egress fixture", settingsFile: join(REPO_ROOT, "settings", "worker.json"), tools,
    containment: { spawn: (options) => {
      args = options.args;
      profileText = readFileSync(join(codexHome, options.args[options.args.indexOf("--profile") + 1]! + ".config.toml"), "utf8");
      return { process: child as never, pid: 11_438 };
    }, teardown: () => {} },
  }, { root, claudeBin: "/unused", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome } }),
  { envPath: selected });
  return { args, profileText };
}

test("a legacy Codex writer egresses through the allowlist proxy, never through open network_access", BOUND, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-egress-legacy-`)));
  try {
    const args = await legacyArgs(root, ["Read", "Write", "Edit", "Bash"]);
    assert.equal(args.includes("sandbox_workspace_write.network_access=true"), false, "open egress is gone");
    assert.equal(args.includes("--sandbox"), false, "the writer profile replaces the legacy sandbox flag");
    assert.ok(hasPair(args, "--enable", "network_proxy"));
    assert.ok(args.includes('default_permissions="rmd_writer"'));
    assert.ok(args.includes('permissions.rmd_writer.extends=":workspace"'), "worktree stays writable, git config protected");
    assert.ok(args.includes(`permissions.rmd_writer.network.domains=${codexNetworkDomains()}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a legacy Codex reader stays read-only with no network", BOUND, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-egress-reader-`)));
  try {
    const args = await legacyArgs(root, ["Read", "Grep"]);
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(args.some((a) => a.includes("network.domains")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a private-registry Codex writer egresses through the allowlist proxy", BOUND, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-egress-private-`)));
  try {
    const { args, profileText } = await privateArgs(root, ["Read", "Edit", "Bash"]);
    assert.ok(hasPair(args, "--enable", "network_proxy"), "the profile's network is behind the proxy");
    assert.ok(args.some((a) => /^permissions\.rmd_registry_[^.]+\.network\.domains=/.test(a)), "the inline override carries the allowlist");
    assert.ok(profileText.includes(`domains=${codexNetworkDomains()}`), "the profile file carries the same allowlist");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the allowlist covers common code hosts, registries, CDNs and docs, and has no catch-all", BOUND, () => {
  for (const host of ["github.com", "api.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com",
    "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "index.crates.io", "proxy.golang.org",
    "repo1.maven.org", "registry-1.docker.io", "ghcr.io", "cdn.jsdelivr.net", "unpkg.com",
    "developer.mozilla.org", "stackoverflow.com", "docs.python.org"]) {
    assert.ok(ALLOWED_NETWORK_DOMAINS.includes(host), `${host} is allowlisted`);
  }
  assert.equal(ALLOWED_NETWORK_DOMAINS.every((d) => /^[a-z0-9.-]+$/.test(d)), true, "exact hosts only: no wildcard, so no catch-all");
  for (const host of ["api.anthropic.com", "*.anthropic.com", "api.openai.com", "*.amazonaws.com", "*.vercel.app"]) {
    assert.equal(ALLOWED_NETWORK_DOMAINS.includes(host), false, `${host} stays out pending the operator's call`);
  }
  assert.equal(codexNetworkDomains(["a.example", "*.b.example"]), '{"a.example"="allow","*.b.example"="allow"}');
});
