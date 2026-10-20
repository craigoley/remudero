import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { OPTION_INTENTS } from "#src/lib/feedback.js";
import { inboxThreadId, readThread } from "#src/lib/inbox-thread.js";
import { INBOX_VERBS, inboxVerbCommand } from "#src/lib/inbox-verdict-command.js";
import { optionAction } from "#src/lib/inbox-plain.js";
import { createOperatorMcpServer, operatorMcpCommand, type OperatorMcpConfig } from "#src/lib/operator-mcp.js";
import { buildInboxVerbActions, buildPanelWriteRoutes, inboxThreadStorePath, inboxTriagePath, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { COMMANDS, HANDLERS, inboxActionCliCommand } from "#src/run-task.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

const ID = "verify-human:W3-T7";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const UNTIL = "2026-10-21T12:00:00Z";

function world(t: { after(fn: () => void): void }): PanelGraphDeps {
  const root = makeTempDir("rmd-inbox-verbs");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inboxRoot = join(root, "control");
  mkdirSync(join(inboxRoot, "state"), { recursive: true });
  mkdirSync(join(root, "plan"));
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  writeFileSync(join(inboxRoot, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: ID, summary: "operator decision", evidenceAnchors: [] }] }));
  const ledgerPath = join(inboxRoot, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return { root, inboxRoot, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve: () => assert.fail("triage must not approve"), reframe: () => assert.fail("triage must not reframe") },
    inboxClock: fixedClock(NOW), inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true };
}

function rows(deps: PanelGraphDeps) {
  return readFileSync(deps.ledgerPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("W1-T10079: every verb the console is served has a route, a command and an MCP tool from one table", async t => {
  const deps = world(t);
  const routes = buildPanelWriteRoutes(deps);
  const server = createOperatorMcpServer({ url: "http://127.0.0.1:4317", readToken: "read", writeToken: "write", repoRoot: deps.root });
  const client = new Client({ name: "verb-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(INBOX_VERBS.map(v => v.name).sort(), ["approve", "archive", "decline", "keep", "reframe", "reply", "restore", "snooze"]);
    for (const verb of INBOX_VERBS) {
      const route = routes.find(r => r.path === verb.path);
      assert.equal(route?.tier, verb.tier);
      assert.equal(route?.scope, "write");
      assert.ok(COMMANDS.some(c => c.name === verb.name));
      assert.equal(typeof HANDLERS.get(verb.name), "function");
      if (verb.name === "approve") assert.equal(verb.tool, undefined);
      else assert.ok(tools.some(tool => tool.name === verb.tool));
    }
    assert.ok(!tools.some(tool => tool.name === "approve_proposal"));
    for (const intent of OPTION_INTENTS) {
      for (const lane of ["ready", "drafting", "notReady", "declined"] as const) {
        const action = optionAction(intent, lane, ID);
        if (action) assert.ok(INBOX_VERBS.some(verb => verb.path === action.path));
      }
    }
  } finally { await client.close(); await server.close(); }
});

test("each MCP inbox verb posts its own fields with the server's write credential", async t => {
  const deps = world(t);
  const calls: { path: string; token?: string; body: unknown }[] = [];
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url!, token: req.headers.authorization, body: JSON.parse(body) });
    res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const server = createOperatorMcpServer({ url, readToken: "read-secret", writeToken: "write-secret", repoRoot: deps.root });
  const client = new Client({ name: "verb-calls", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const inputs = {
      decline: { proposalId: ID, reason: "superseded" }, restore: { proposalId: ID, reason: "reconsider" },
      reframe: { proposalId: ID, feedback: "narrow this" }, reply: { threadId: inboxThreadId(ID), text: "continue", intentId: "intent-10079" },
      archive: { proposalId: ID, archived: true }, snooze: { proposalId: ID, until: UNTIL }, keep: { proposalId: ID, reason: "wait" },
    };
    for (const verb of INBOX_VERBS) {
      if (verb.name === "approve") continue;
      const body = inputs[verb.name];
      assert.equal((await client.callTool({ name: verb.tool!, arguments: body })).isError, undefined);
      assert.deepEqual(calls.at(-1), { path: verb.path, token: "Bearer write-secret", body });
      assert.equal((await client.callTool({ name: verb.tool!, arguments: { ...body, token: "caller-secret" } })).isError, true);
      assert.equal((await client.callTool({ name: verb.tool!, arguments: {} })).isError, true);
    }
    assert.equal(calls.length, 7);
    assert.equal((await client.callTool({ name: "approve_proposal", arguments: { proposalId: ID } })).isError, true);
    assert.equal((await client.callTool({ name: "archive_proposal", arguments: { proposalId: ID, archived: "yes" } })).isError, true);
    assert.equal((await client.callTool({ name: "reply_thread", arguments: { threadId: inboxThreadId(ID), text: "x".repeat(4001) } })).isError, true);
    assert.equal(calls.length, 7);
  } finally { await client.close(); await server.close(); await new Promise<void>(resolve => http.close(() => resolve())); }
});

test("MCP reads its credentials from config.root and exposes inbox writes only when enabled", async t => {
  const deps = world(t);
  writeFileSync(join(deps.inboxRoot, "state", "service-tokens.json"), JSON.stringify({ read: "stored-read", write: "stored-write" }));
  for (const enabled of [false, true]) {
    let observed: OperatorMcpConfig | undefined;
    await operatorMcpCommand(enabled ? ["--enable-write"] : [], { root: deps.inboxRoot }, deps.root, config => {
      observed = config;
      const server = createOperatorMcpServer(config);
      server.connect = async () => {};
      return server;
    });
    assert.equal(observed!.readToken, "stored-read");
    assert.equal(observed!.writeToken, enabled ? "stored-write" : undefined);
    const server = createOperatorMcpServer(observed!);
    const client = new Client({ name: "credential-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.equal(names.includes("snooze_proposal"), enabled);
      if (!enabled) {
        assert.equal((await client.callTool({ name: "snooze_proposal", arguments: { proposalId: ID, until: UNTIL } })).isError, true);
        assert.deepEqual(names, ["inbox", "ledger_grep", "case_file"]);
      }
    } finally { await client.close(); await server.close(); }
  }
});

test("CLI wiring uses the configured inbox root and records replies on the shared thread", async t => {
  const deps = world(t);
  const config = { root: deps.inboxRoot } as Config;
  assert.equal(await inboxActionCliCommand("archive", [ID], config, deps), 0);
  assert.equal(await inboxActionCliCommand("snooze", [ID, "--until", UNTIL], config, deps), 0);
  assert.equal(await inboxActionCliCommand("keep", [ID], config, deps), 0);
  assert.equal(await inboxActionCliCommand("reply", [inboxThreadId(ID), "--text", "watch the next run", "--intent-id", "intent-10079"], config, deps), 0);
  const thread = readThread(inboxThreadId(ID), { threadStorePath: inboxThreadStorePath(deps.inboxRoot) });
  assert.equal(thread.status, "ok");
  if (thread.status === "ok") assert.equal(thread.messages.at(-1)!.body, "watch the next run");
  assert.deepEqual(rows(deps).map(row => row.origin), ["rmd-cli", "rmd-cli", "rmd-cli", "rmd-cli"]);
});

for (const [name, title] of [
  ["snooze", "W1-T10079: rmd snooze writes the same mark and row as POST /v1/inbox/snooze"],
  ["archive", "W1-T10079: rmd archive writes the same mark and row as POST /v1/inbox/archive"],
] as const) {
  test(title, async t => {
    const cli = world(t), http = world(t);
    assert.equal(await inboxVerbCommand(name, [ID, ...(name === "snooze" ? ["--until", UNTIL] : [])], buildInboxVerbActions(cli)), 0);
    const service = createService({ tokens: { read: "read", write: "write" }, routes: buildPanelWriteRoutes(http) });
    await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
    try {
      const address = service.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/inbox/${name}`, { method: "POST",
        headers: { authorization: "Bearer write", "content-type": "application/json" },
        body: JSON.stringify({ proposalId: ID, ...(name === "snooze" ? { until: UNTIL } : { archived: true }) }) });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(readFileSync(inboxTriagePath(join(cli.inboxRoot, "state")), "utf8")), JSON.parse(readFileSync(inboxTriagePath(join(http.inboxRoot, "state")), "utf8")));
      const [local] = rows(cli), [remote] = rows(http);
      assert.equal(local.origin, "rmd-cli");
      for (const field of ["step", "task_id", name === "snooze" ? "until" : "archived"]) assert.equal(local[field], remote[field]);
      assert.equal(await inboxVerbCommand(name, [ID, name === "snooze" ? "--wake" : "--undo"], buildInboxVerbActions(cli)), 0);
      assert.deepEqual(JSON.parse(readFileSync(inboxTriagePath(join(cli.inboxRoot, "state")), "utf8")), {});
    } finally { await new Promise<void>(resolve => service.close(() => resolve())); }
  });
}

test("inbox commands reject malformed flags, unknown items and past snoozes without a ledger write", async t => {
  const deps = world(t), actions = buildInboxVerbActions(deps);
  for (const [name, args] of [["snooze", [ID]], ["snooze", [ID, "--wake", "--until", UNTIL]],
    ["archive", [ID, "--reason", "x"]], ["keep", [ID, "--reason"]], ["archive", [ID, "--undo", "--undo"]]] as const) {
    assert.equal(await inboxVerbCommand(name, [...args], actions), 2);
  }
  assert.equal(await inboxVerbCommand("snooze", [ID, "--until", "yesterday"], actions), 2);
  assert.equal(await inboxVerbCommand("snooze", [ID, "--until", "2026-10-19T12:00:00Z"], actions), 2);
  assert.equal(await inboxVerbCommand("archive", ["unknown"], actions), 1);
  assert.deepEqual(rows(deps), []);
});

test("rmd keep records a reversible observation with its reason", async t => {
  const deps = world(t), actions = buildInboxVerbActions(deps);
  assert.equal(await inboxVerbCommand("keep", [ID, "--reason", "watch the next run"], actions), 0);
  const [row] = rows(deps);
  assert.equal(row.step, "inbox.kept");
  assert.equal(row.reason, "watch the next run");
  assert.equal(row.origin, "rmd-cli");
  assert.ok(JSON.parse(readFileSync(inboxTriagePath(join(deps.inboxRoot, "state")), "utf8"))[ID].keptState);
  assert.equal(await inboxVerbCommand("keep", [ID, "--undo"], actions), 0);
  assert.deepEqual(JSON.parse(readFileSync(inboxTriagePath(join(deps.inboxRoot, "state")), "utf8")), {});
});
