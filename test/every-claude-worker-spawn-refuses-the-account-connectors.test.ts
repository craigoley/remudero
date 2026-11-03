import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { query, type Options, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
// @ts-expect-error -- plain .mjs script, no type declarations
import { censusWorkerMcpExposure } from "#scripts/worker-mcp-exposure-census.mjs";
import { ACCOUNT_CONNECTOR_DENY } from "#src/lib/worker-mcp-isolation.js";
import { CLAUDE_BIN_ENV_OVERRIDE, createClaudeExecutableCache, openUsageProbeSession, spawnWorker, workerLedgerFields,
  type UsageProbeQueryFn } from "#src/lib/worker.js";

/**
 * W1-T9489. Every Claude worker spawn (fix, implement, review, recon) ran under bypassPermissions with the fleet account's
 * claude.ai connectors attached: 120 ledger rows on 2026-10-13/14 listed all eight mcp__claude_ai_Claude_Docs__* tools.
 * These tests drive the real `spawnWorker` with an injected query function, so they assert the options it hands the SDK and
 * the ledger row it produces, never a live CLI.
 */

const DOCS_TOOLS = ["batch", "create", "delete", "export", "guide", "query", "read", "update"]
  .map(name => `mcp__claude_ai_Claude_Docs__${name}`);
const RULE = "mcp__knowledge__rule";
/** The init message shape the 2026-10-14 rows were summarized from: the connector's server name has spaces. */
const leakedInit = (knowledge: boolean) => ({ type: "system", subtype: "init",
  mcp_servers: [...(knowledge ? [{ name: "knowledge", status: "connected" }] : []), { name: "claude.ai Claude Docs", status: "connected" }],
  tools: ["Read", "Bash", ...DOCS_TOOLS, ...(knowledge ? [RULE] : [])] });
const cleanInit = (knowledge: boolean) => ({ type: "system", subtype: "init",
  mcp_servers: knowledge ? [{ name: "knowledge", status: "connected" }] : [], tools: ["Read", "Bash", ...(knowledge ? [RULE] : [])] });

async function spawn(t: { after(fn: () => void): void }, opts: { knowledge?: boolean; disallowedTools?: string[]; events?: unknown[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t9489-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsFile = join(root, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  let options: Options | undefined;
  const result = await spawnWorker({ cwd: root, settingsFile, permissionMode: "bypassPermissions", prompt: "fixture",
    tools: ["Read", "Bash"], ...(opts.knowledge ? { ruleLookup: { onPulled: () => {} } } : {}),
    ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
    egress: { mode: "off" }, config: { root, claudeBin: "/unused" },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" },
      home: root, exists: () => true, canExecute: () => true, locations: [] } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }) },
    queryFn: ((params: { options: Options }) => {
      options = params.options;
      return (async function* () {
        for (const event of opts.events ?? []) yield event;
        yield { type: "result", subtype: "success", is_error: false, result: "fixture done", session_id: "fixture", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as never,
  });
  assert.ok(options, "spawnWorker never reached the SDK");
  return { options, result };
}

/** The CLI argv the REAL SDK builds from these options, and what it writes to the CLI's stdin. The spawner is a stub that
 * records both and exits, so no process is created. The pinned CLI (2.1.293) skips the headless claude.ai connector sync
 * whenever --strict-mcp-config is set, so this flag in argv is what keeps every account connector from loading. */
async function cliLaunch(options: Options): Promise<{ argv: string[]; stdin: string }> {
  let argv: string[] | undefined;
  let stdin = "";
  const session = query({ prompt: "fixture", options: { ...options, pathToClaudeCodeExecutable: "/nonexistent/claude",
    spawnClaudeCodeProcess: (spawned) => {
      argv = spawned.args;
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; killed: boolean; exitCode: number | null; kill(): boolean };
      child.stdin = new PassThrough();
      child.stdin.on("data", (chunk: Buffer) => { stdin += chunk.toString("utf8"); });
      child.stdout = new PassThrough();
      child.killed = false;
      child.exitCode = null;
      child.kill = () => {
        child.killed = true;
        child.exitCode = 0;
        child.stdout.end();
        setImmediate(() => child.emit("exit", 0, null));
        return true;
      };
      setTimeout(() => child.kill(), 20);
      return child as unknown as SpawnedProcess;
    } } });
  try {
    for await (const _ of session) { /* the stub emits nothing */ }
  } catch {
    // deliberate: the stub exits without a result, which the SDK reports as an error; only the argv matters here.
  }
  assert.ok(argv, "the SDK never reached the spawner");
  return { argv, stdin };
}

/** The in-process servers the SDK announces to the CLI in its initialize request. */
function sdkServersAnnounced(stdin: string): string[] {
  for (const line of stdin.split("\n")) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as { type?: string; request?: { subtype?: string; sdkMcpServers?: string[] } };
    if (message.type === "control_request" && message.request?.subtype === "initialize") return message.request.sdkMcpServers ?? [];
  }
  throw new Error(`no initialize request reached the CLI's stdin: ${stdin.slice(0, 200)}`);
}

// Knowledge-only when ruleLookup is set, and empty otherwise; the usage probe gets the same boundary.
test("every claude worker spawn passes strictMcpConfig with an explicit server map", async t => {
  const plain = await spawn(t, { events: [cleanInit(false)] });
  assert.equal(plain.options.strictMcpConfig, true);
  assert.deepEqual(plain.options.mcpServers, {});
  const knowledge = await spawn(t, { knowledge: true, events: [cleanInit(true)] });
  assert.equal(knowledge.options.strictMcpConfig, true);
  assert.deepEqual(Object.keys(knowledge.options.mcpServers ?? {}), ["knowledge"]);
  assert.deepEqual(knowledge.options.tools, ["Read", "Bash", RULE], "the knowledge tool is still offered");

  for (const [spawned, announced] of [[plain, []], [knowledge, ["knowledge"]]] as const) {
    const { argv, stdin } = await cliLaunch(spawned.options);
    assert.ok(argv.includes("--strict-mcp-config"), `the CLI is told to ignore every other MCP source: ${argv.join(" ")}`);
    assert.equal(argv.includes("--mcp-config"), false, "no process-backed server is handed to the CLI");
    assert.deepEqual(sdkServersAnnounced(stdin), announced, "the only server is the in-process knowledge one, and only with ruleLookup");
  }

  for (const { result } of [plain, knowledge]) {
    assert.equal(result.isError, false);
    assert.equal(workerLedgerFields(result).mcp_boundary, "strict");
    assert.equal("mcp_exposure" in workerLedgerFields(result), false, "an observed clean inventory carries no exposure");
  }

  let probe: Parameters<UsageProbeQueryFn>[0]["options"] | undefined;
  const session = openUsageProbeSession(params => {
    probe = params.options;
    return { return: async () => undefined };
  }, { platform: "darwin", claudeExecutable: { cache: createClaudeExecutableCache(), deps: { env: {}, home: "/nonexistent", which: () => undefined, exists: () => false, canExecute: () => false, locations: [] } } });
  await session.return?.();
  assert.equal(probe?.strictMcpConfig, true, "the usage probe opens on the same config dir, under the same boundary");
  assert.deepEqual(probe?.mcpServers, {});
});

test("every claude worker spawn denies the account connector tools even beside its own disallowedTools", async t => {
  const bare = await spawn(t);
  assert.deepEqual(bare.options.disallowedTools, [...ACCOUNT_CONNECTOR_DENY]);
  const caller = await spawn(t, { disallowedTools: ["WebSearch", "WebFetch"] });
  assert.deepEqual(caller.options.disallowedTools, ["WebSearch", "WebFetch", ...ACCOUNT_CONNECTOR_DENY], "merged, never replaced");
  assert.ok(ACCOUNT_CONNECTOR_DENY.includes("mcp__claude_ai_Claude_Docs"), "the connector the fleet account carries today");
  // Server-level, exact-name entries: the pinned CLI matches a server deny by exact server name, so a `mcp__claude_ai_*`
  // spelling would name the server "claude_ai_*" and deny nothing.
  for (const entry of ACCOUNT_CONNECTOR_DENY) assert.match(entry, /^mcp__claude_ai_[A-Za-z0-9_-]+$/);
  const { argv } = await cliLaunch(caller.options);
  // The installed SDK 0.3.296 serializes this option as one flag=value argument.
  // Require exactly one complete deny list; a missing flag must not read argv[0].
  const denyArgs = argv.filter(arg => arg.startsWith("--disallowedTools="));
  assert.equal(denyArgs.length, 1, "the SDK must send exactly one account-connector deny list");
  const denied = denyArgs[0]!.slice("--disallowedTools=".length).split(",");
  assert.deepEqual(denied, ["WebSearch", "WebFetch", ...ACCOUNT_CONNECTOR_DENY]);
});

test("a worker whose init inventory lists an account connector is ledgered as exposed and earns no credit", async t => {
  for (const knowledge of [false, true]) {
    const { result } = await spawn(t, { knowledge, events: [leakedInit(knowledge)] });
    assert.equal(result.isError, true);
    assert.equal(result.subtype, "error_mcp_exposure", "callers grade {isError, subtype: success} as clean, so the subtype moves too");
    const row = workerLedgerFields(result);
    assert.equal(row.verdict, "error_mcp_exposure");
    assert.equal(row.mcp_boundary, "strict");
    assert.equal(row.mcp_exposure?.state, "exposed");
    assert.deepEqual(row.mcp_exposure?.tools, DOCS_TOOLS);
    assert.equal(row.mcp_exposure?.rejected_server_entries, 1, "the unrenderable \"claude.ai Claude Docs\" server counts");
    assert.equal(row.mcp_exposure?.original_subtype, "success");
  }
  // The server name alone, hidden by the summary, is exposure: a check reading names only would call this clean.
  const hidden = await spawn(t, { events: [{ type: "system", subtype: "init", mcp_servers: [{ name: "claude.ai Claude Docs" }], tools: ["Read"] }] });
  assert.equal(hidden.result.isError, true);
  assert.equal(hidden.result.mcpExposure?.rejected_server_entries, 1);
  // A server the spawn did not declare is exposure even with a renderable name.
  const foreign = await spawn(t, { events: [{ type: "system", subtype: "init", mcp_servers: [{ name: "knowledge" }], tools: ["Read", RULE] }] });
  assert.equal(foreign.result.isError, true);
  assert.deepEqual(foreign.result.mcpExposure?.servers, ["knowledge"]);
  // No inventory at all is unknown, never clean, and is not by itself a failure.
  const silent = await spawn(t);
  assert.equal(silent.result.isError, false);
  assert.equal(workerLedgerFields(silent.result).mcp_exposure?.state, "unknown");
});

const SCRIPT = fileURLToPath(new URL("../scripts/worker-mcp-exposure-census.mjs", import.meta.url));

test("the exposure census fails on a strict-boundary row that lists an account connector", t => {
  // A 2026-10-14 row as the ledger recorded it (pre-fix), and the same row re-tagged as spawned under the boundary.
  const preFix = { ts: "2026-10-14T14:40:56.468Z", run_id: "W1-T8240-1791902009809", step: "implement.done", provider: "claude",
    sdk_init_summary: { schema: "sdk-init-summary-v1", source: "claude-sdk-system-init", state: "partial",
      serverNames: { state: "partial", names: ["knowledge"], inputEntries: 2, inspectedEntries: 2, rejectedEntries: 1, truncated: false },
      mcpToolNames: { state: "observed", names: [...DOCS_TOOLS, RULE], inputEntries: 15, inspectedEntries: 15, rejectedEntries: 0, truncated: false } } };
  const strictLeak = { ...preFix, run_id: "W1-T9489-1", mcp_boundary: "strict" };
  const strictClean = { ...preFix, run_id: "W1-T9489-2", mcp_boundary: "strict", sdk_init_summary: { ...preFix.sdk_init_summary, state: "observed",
    serverNames: { ...preFix.sdk_init_summary.serverNames, state: "observed", inputEntries: 1, inspectedEntries: 1, rejectedEntries: 0 },
    mcpToolNames: { ...preFix.sdk_init_summary.mcpToolNames, names: [RULE] } } };

  const pure = censusWorkerMcpExposure([preFix, strictLeak, strictClean]);
  assert.equal(pure.preFixRows, 1);
  assert.equal(pure.preFixExposed, 1);
  assert.equal(pure.strictRows, 2);
  assert.deepEqual(pure.exposed.map((row: { run_id: string }) => row.run_id), ["W1-T9489-1"]);

  const dir = mkdtempSync(join(tmpdir(), "rmd-t9489-census-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (rows: object[]) => {
    const file = join(dir, `ledger-${rows.length}-${Math.random().toString(36).slice(2)}.ndjson`);
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, file], { encoding: "utf8" });
  };
  const failing = run([preFix, strictLeak, strictClean]);
  assert.equal(failing.status, 1, failing.stderr);
  assert.match(failing.stdout, /EXPOSED W1-T9489-1 implement\.done .*mcp__claude_ai_Claude_Docs__delete/);
  assert.doesNotMatch(failing.stdout, /EXPOSED W1-T8240/);
  const preFixOnly = run([preFix, strictClean]);
  assert.equal(preFixOnly.status, 0, preFixOnly.stdout + preFixOnly.stderr);
  assert.match(preFixOnly.stdout, /1 pre-fix row\(s\) \(1 of them exposed, reported only\)/);

  // The union path: a state dir read through readLedgerUnionRawLinesSync, never a full-record union read.
  const stateDir = join(dir, "state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "ledger.ndjson"), [preFix, strictLeak].map(row => JSON.stringify(row)).join("\n") + "\nnot json \"sdk_init_summary\"\n");
  const union = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--state-dir", stateDir], { encoding: "utf8" });
  assert.equal(union.status, 1, union.stdout + union.stderr);
  assert.match(union.stdout, /1 strict-boundary row\(s\), 1 pre-fix row\(s\)/);
  for (const argv of [[], ["--state-dir"]]) {
    const usage = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...argv], { encoding: "utf8" });
    assert.equal(usage.status, 2, `a usage error is neither clean nor exposed: ${usage.stdout}`);
  }
});
