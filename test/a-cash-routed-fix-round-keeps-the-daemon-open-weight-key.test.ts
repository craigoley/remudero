import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnWorker } from "#src/lib/worker.js";
import { openWeightCheckEnv, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import type { Config } from "#src/lib/config.js";

const KEY = "fixture-only-daemon-key";
const ENV_KEYS = ["RMD_OPENWEIGHT_API_KEY", "RMD_FOUNDRY_CLAUDE_API_KEY", "RMD_FOUNDRY_CLAUDE_ENDPOINT"] as const;
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-env-"));
  const prior = ENV_KEYS.map(key => process.env[key]);
  process.env.RMD_OPENWEIGHT_API_KEY = KEY;
  process.env.RMD_FOUNDRY_CLAUDE_API_KEY = KEY;
  process.env.RMD_FOUNDRY_CLAUDE_ENDPOINT = "https://foundry.example.test/anthropic";
  t.after(() => {
    ENV_KEYS.forEach((key, i) => { if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i]; });
    rmSync(root, { recursive: true, force: true });
  });
  const config: Config = { root, claudeBin: "/unused", dailyCapUsd: 25,
    workerProviders: { enabled: ["cash"], cashEndpoint: "https://foundry.example.test/" } };
  return { root, config, snapshot: join(root, "census.json") };
}
function reply(message: Record<string, unknown>) {
  return new Response(JSON.stringify({ id: "fixture", usage: { prompt_tokens: 10, completion_tokens: 2 },
    choices: [{ finish_reason: "stop", message }] }), { status: 200 });
}

test("W1-T10024: a cash spawn with env extras still sends the daemon open-weight key", async t => {
  const f = fixture(t);
  let requests = 0;
  const result = await spawnWorker({ cwd: f.root, config: f.config, prompt: "Return CASH_OK", model: "sonnet",
    tools: [], mountProvider: "cash", permissionMode: "bypassPermissions", settingsFile: join(process.cwd(), "settings/worker.json"),
    env: { RMD_CENSUS_SNAPSHOT: f.snapshot },
    providerRouting: { writeStatus: () => {}, spawnOpenWeight: (args, config, selection) =>
      spawnOpenWeightWorker({ ...args, fetchImpl: async (_url, init) => {
        requests++;
        assert.equal(new Headers(init?.headers).get("api-key"), KEY);
        return reply({ content: "CASH_OK" });
      } }, config, selection) } });
  assert.equal(result.isError, false, result.stderr);
  assert.equal(result.text, "CASH_OK");
  assert.equal(requests, 1, "the real adapter, not just routing, reaches transport");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
});

test("W1-T10024: env extras reach the check child and the open-weight key does not", async t => {
  const f = fixture(t);
  let checked = 0, requests = 0;
  let checkEnv: Record<string, string> = {};
  const result = await spawnWorker({ cwd: f.root, config: f.config, prompt: "Run git_status then report", model: "sonnet",
    tools: ["RunCheck"], maxTurns: 2, mountProvider: "cash", permissionMode: "bypassPermissions",
    settingsFile: join(process.cwd(), "settings/worker.json"), env: { RMD_CENSUS_SNAPSHOT: f.snapshot },
    providerRouting: { writeStatus: () => {}, spawnOpenWeight: (args, config, selection) =>
      spawnOpenWeightWorker({ ...args, fetchImpl: async () => ++requests === 1
        ? reply({ tool_calls: [{ id: "check-1", type: "function", function: {
          name: "run_check", arguments: JSON.stringify({ check: "git_status" }) } }] })
        : reply({ content: "CHECK_OK" }),
      runCheck: input => {
        checked++;
        checkEnv = input.env;
        assert.equal(input.env.RMD_CENSUS_SNAPSHOT, f.snapshot);
        assert.deepEqual(input.argv, ["git", "status", "--porcelain"]);
        assert.ok(input.env.HOME.startsWith(f.root));
        assert.equal(input.env.TMPDIR, join(input.env.HOME, "tmp"));
        assert.equal(input.env.RMD_OPENWEIGHT_API_KEY, undefined);
        assert.equal(input.env.RMD_FOUNDRY_CLAUDE_API_KEY, undefined);
        assert.equal(input.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
        assert.equal(input.env.GH_TOKEN, undefined);
        assert.ok(!Object.keys(input.env).some(k => /^ANTHROPIC_/i.test(k)));
        return "";
      } }, config, selection) } });
  assert.equal(result.isError, false, result.stderr);
  assert.equal(result.text, "CHECK_OK");
  assert.equal(checked, 1);
  assert.equal(requests, 2);
  assert.equal(checkEnv.RMD_CENSUS_SNAPSHOT, f.snapshot, "assert outside the tool's deliberate error-to-result boundary");
  assert.equal(checkEnv.RMD_OPENWEIGHT_API_KEY, undefined);
});

test("cash env extras cannot impersonate a daemon credential or replace private check paths", async t => {
  const f = fixture(t);
  const home = join(f.root, "private");
  for (const key of ["ANTHROPIC_API_KEY", "anthropic_base_url", "RMD_OPENWEIGHT_API_KEY",
    "RMD_FOUNDRY_CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"]) {
    assert.throws(() => openWeightCheckEnv(home, {}, { [key]: "forbidden" }), /credential|billing-boundary/);
  }
  const child = openWeightCheckEnv(home, { PATH: "/usr/bin", LANG: "C", LC_ALL: "C" },
    { RMD_CENSUS_SNAPSHOT: f.snapshot, HOME: "/escape", TMPDIR: "/escape" });
  assert.equal(child.HOME, home);
  assert.equal(child.TMPDIR, join(home, "tmp"));
  assert.equal(child.RMD_CENSUS_SNAPSHOT, f.snapshot);
});

test("cash worker extras do not mask missing daemon credentials or adapter test overrides", async t => {
  const f = fixture(t);
  let requests = 0;
  const args = { cwd: f.root, prompt: "Return OK", workerHome: join(f.root, "home"), tools: [],
    workerEnv: { RMD_CENSUS_SNAPSHOT: f.snapshot }, env: {},
    fetchImpl: async () => { requests++; return reply({ content: "OK" }); } };
  const missing = await spawnOpenWeightWorker(args, f.config, { model: "gpt-oss-120b", effort: "low" });
  assert.equal(missing.isError, true);
  assert.match(missing.stderr, /requires RMD_OPENWEIGHT_API_KEY/);
  assert.equal(requests, 0, "test-only full env remains authoritative even with a real daemon key");
  const sent = await spawnOpenWeightWorker({ ...args, env: { RMD_OPENWEIGHT_API_KEY: KEY } },
    f.config, { model: "gpt-oss-120b", effort: "low" });
  assert.equal(sent.isError, false, sent.stderr);
  assert.equal(requests, 1);
});

test("Foundry Claude forwards worker extras without exposing its daemon key", async t => {
  const f = fixture(t);
  let requests = 0, checked = 0;
  let checkEnv: Record<string, string> = {};
  const result = await spawnOpenWeightWorker({ cwd: f.root, prompt: "Check status", workerHome: join(f.root, "home"),
    tools: ["RunCheck"], maxTurns: 2, workerEnv: { RMD_CENSUS_SNAPSHOT: f.snapshot },
    fetchImpl: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("x-api-key"), KEY);
      const content = ++requests === 1
        ? [{ type: "tool_use", id: "check", name: "run_check", input: { check: "git_status" } }]
        : [{ type: "text", text: "OK" }];
      return new Response(JSON.stringify({ id: "fixture", stop_reason: requests === 1 ? "tool_use" : "end_turn", content,
        usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
    }, runCheck: input => {
      checked++;
      checkEnv = input.env;
      assert.equal(input.env.RMD_CENSUS_SNAPSHOT, f.snapshot);
      assert.equal(input.env.RMD_FOUNDRY_CLAUDE_API_KEY, undefined);
      assert.equal(input.env.RMD_OPENWEIGHT_API_KEY, undefined);
      return "";
    } }, f.config, { model: "claude-haiku-5-5", effort: "low" });
  assert.equal(result.isError, false, result.stderr);
  assert.equal(checked, 1);
  assert.equal(requests, 2);
  assert.equal(checkEnv.RMD_CENSUS_SNAPSHOT, f.snapshot);
  assert.equal(checkEnv.RMD_FOUNDRY_CLAUDE_API_KEY, undefined);
});
