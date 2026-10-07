// W1-T6157: A CLAUDE WORKER CANNOT RUN AN UNSANDBOXED COMMAND.
//
// The installed Agent SDK documents `sandbox.allowUnsandboxedCommands` as defaulting to TRUE, and
// every worker spawn runs under `bypassPermissions`, which approves the prompt a Bash call carrying
// `dangerouslyDisableSandbox` would otherwise raise. Before this task the committed worker policy
// never set the key, so a worker could run any command outside the OS sandbox — past every
// filesystem.denyRead / denyWrite entry and the egress allowlist. These tests pin the committed
// policy, the file the real renderer writes, the validator's refusal, and the spawn boundary.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateWorkerSettings,
  validateWorkerSettingsFile,
  WorkerSettingsError,
} from "../src/lib/settings.js";
import {
  CLAUDE_BIN_ENV_OVERRIDE,
  createClaudeExecutableCache,
  renderWorkerSettings,
  spawnWorker,
  type SpawnWorkerArgs,
} from "../src/lib/worker.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(REPO_ROOT, "settings", "worker.json");

type Sandbox = Record<string, unknown>;

function committedPolicy(): { sandbox: Sandbox } & Record<string, unknown> {
  return JSON.parse(readFileSync(TEMPLATE, "utf8")) as { sandbox: Sandbox } & Record<string, unknown>;
}

/** Render the committed template through the REAL renderer into a throwaway dir. */
function renderedPolicyFile(dir: string): string {
  return renderWorkerSettings({
    templatePath: TEMPLATE,
    hooksDir: join(dir, "hooks"),
    outPath: join(dir, "rendered", "worker.json"),
  });
}

function namesTheKey(e: unknown): boolean {
  return e instanceof WorkerSettingsError && /sandbox\.allowUnsandboxedCommands/.test(e.message);
}

test("the committed worker policy sets sandbox.allowUnsandboxedCommands to false", () => {
  const policy = committedPolicy();
  assert.equal(policy.sandbox.allowUnsandboxedCommands, false);
  assert.doesNotThrow(() => validateWorkerSettingsFile(TEMPLATE));
});

test("the settings file the real renderer writes carries allowUnsandboxedCommands false and validates", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t6157-render-"));
  const rendered = renderedPolicyFile(dir);
  const parsed = validateWorkerSettingsFile(rendered) as { sandbox: Sandbox };
  assert.equal(parsed.sandbox.allowUnsandboxedCommands, false);
});

test("the validator refuses a worker policy where allowUnsandboxedCommands is absent, by name", () => {
  const policy = committedPolicy();
  delete policy.sandbox.allowUnsandboxedCommands;
  assert.throws(() => validateWorkerSettings(policy), namesTheKey);
});

test("the validator refuses a worker policy where allowUnsandboxedCommands is true, by name", () => {
  const policy = committedPolicy();
  policy.sandbox.allowUnsandboxedCommands = true;
  assert.throws(() => validateWorkerSettings(policy), namesTheKey);
});

test("the validator refuses a non-boolean allowUnsandboxedCommands rather than reading it as false", () => {
  const policy = committedPolicy();
  policy.sandbox.allowUnsandboxedCommands = "false";
  assert.throws(() => validateWorkerSettings(policy), namesTheKey);
});

test("every other sandbox key the committed policy declares is unchanged", () => {
  const { allowUnsandboxedCommands: _added, ...rest } = committedPolicy().sandbox;
  assert.deepEqual(rest, {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      denyRead: [
        "~/../../.ssh/**",
        "~/../../.aws/**",
        "~/../../.config/remudero/**",
        "~/../state/service-tokens.json",
      ],
      denyWrite: [
        "~/../repos/*/.git/config",
        "~/../repos/*/.git/config.worktree",
        "~/../repos/*/.git/commondir",
        "~/../repos/*/.git/hooks/**",
        "~/../repos/*/.git/worktrees/*/config.worktree",
        "~/../repos/*/.git/worktrees/*/commondir",
        "~/../repos/*/.git/worktrees/*/gitdir",
      ],
    },
    network: {
      allowedDomains: ["github.com", "api.github.com", "codeload.github.com", "registry.npmjs.org"],
    },
    excludedCommands: ["gh *"],
  });
});

test("the installed SDK documents that false makes dangerouslyDisableSandbox completely ignored", () => {
  // The fix relies on this documented semantics; an SDK bump that changes it must red here.
  const require = createRequire(import.meta.url);
  const sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const dts = readFileSync(join(sdkDir, "sdk.d.ts"), "utf8");
  const doc = dts.match(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*allowUnsandboxedCommands\?: boolean;/);
  assert.ok(doc, "sdk.d.ts must still declare a documented allowUnsandboxedCommands");
  assert.match(doc[1], /When false, the dangerouslyDisableSandbox parameter is completely ignored/);
});

// ── The spawn boundary: the previously-allowed escape is refused before any worker launches ──

function spawnArgs(dir: string, settingsFile: string, queryFn: SpawnWorkerArgs["queryFn"]): SpawnWorkerArgs {
  return {
    cwd: dir,
    permissionMode: "bypassPermissions",
    settingsFile,
    prompt: "W1-T6157 fixture",
    config: { claudeBin: "/unused", root: dir },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: {
        env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" },
        home: dir,
        exists: () => true,
        canExecute: () => true,
        locations: [],
      },
    },
    keychain: {
      platform: "linux" as NodeJS.Platform,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }),
    },
    queryFn,
  } as SpawnWorkerArgs;
}

function recordingQueryFn(seen: Array<{ settings: unknown; permissionMode: unknown }>): SpawnWorkerArgs["queryFn"] {
  return ((params: { options: { settings?: string; permissionMode?: string } }) => {
    seen.push({
      settings: params.options.settings ? JSON.parse(readFileSync(params.options.settings, "utf8")) : undefined,
      permissionMode: params.options.permissionMode,
    });
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-t6157",
        total_cost_usd: 0,
        num_turns: 1,
      };
    })();
  }) as unknown as SpawnWorkerArgs["queryFn"];
}

test("a bypassPermissions worker spawned from the rendered policy hands the SDK allowUnsandboxedCommands false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t6157-spawn-"));
  const seen: Array<{ settings: unknown; permissionMode: unknown }> = [];
  await spawnWorker(spawnArgs(dir, renderedPolicyFile(dir), recordingQueryFn(seen)));
  assert.equal(seen.length, 1, "the fake SDK query ran exactly once");
  assert.equal(seen[0].permissionMode, "bypassPermissions");
  assert.equal((seen[0].settings as { sandbox: Sandbox }).sandbox.allowUnsandboxedCommands, false);
});

test("a worker policy without the switch is refused at spawnWorker with nothing spawned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t6157-refuse-"));
  const rendered = JSON.parse(readFileSync(renderedPolicyFile(dir), "utf8")) as { sandbox: Sandbox };
  delete rendered.sandbox.allowUnsandboxedCommands; // the policy as it stood at base
  const settingsFile = join(dir, "pre-fix-worker.json");
  writeFileSync(settingsFile, JSON.stringify(rendered));
  const seen: Array<{ settings: unknown; permissionMode: unknown }> = [];
  await assert.rejects(() => spawnWorker(spawnArgs(dir, settingsFile, recordingQueryFn(seen))), namesTheKey);
  assert.equal(seen.length, 0, "the SDK query is never reached");
});
