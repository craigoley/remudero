import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOperatorMcpServer, operatorMcpCommand, type OperatorMcpConfig } from "../src/lib/operator-mcp.js";
import { gitRepo } from "./helpers/git-repo.js";

const base: OperatorMcpConfig = { url: "http://127.0.0.1:4317", readToken: "read-scope-secret", repoRoot: process.cwd() };
async function connected(deps: OperatorMcpConfig = base) {
  const server = createOperatorMcpServer(deps);
  const client = new Client({ name: "operator-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function content(result: Awaited<ReturnType<Client["callTool"]>>) { return JSON.stringify(result.content); }

async function fixture() {
  const repo = gitRepo({ kind: "operator-mcp" });
  mkdirSync(join(repo.dir, "src"));
  symlinkSync(resolve("node_modules"), join(repo.dir, "node_modules"), "dir");
  const script = join(repo.dir, "src", "run-task.ts");
  writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const calls: Array<{ url: string; method: string; token: string | undefined; body: string }> = [];
  let mode = "ok";
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url!, method: req.method!, token: req.headers.authorization, body });
    if (mode === "refused") { res.writeHead(403); res.end("read-scope-secret refused"); }
    else if (mode === "large") res.end("x".repeat(1024 * 1024 + 1));
    else res.end('{"staleness":"unavailable","recorded":true}');
  });
  await new Promise<void>(r => http.listen(0, "127.0.0.1", r));
  return { config: { ...base, repoRoot: repo.dir, url: `http://127.0.0.1:${(http.address() as { port: number }).port}` }, script, calls,
    mode: (value: string) => { mode = value; }, close: async () => { await new Promise<void>(r => http.close(() => r())); repo.cleanup(); } };
}

test("W1-T4679: the operator MCP server exposes the inbox and ledger-grep read tools", async () => {
  const f = await fixture(), pair = await connected(f.config);
  try {
    assert.deepEqual((await pair.client.listTools()).tools.map(t => t.name), ["inbox", "ledger_grep", "case_file"]);
    assert.match(content(await pair.client.callTool({ name: "inbox" })), /unavailable/);
    assert.match(content(await pair.client.callTool({ name: "ledger_grep", arguments: { pattern: "goal[.]unmoved" } })), /goal/);
    assert.match(content(await pair.client.callTool({ name: "case_file", arguments: { taskId: "W1-T12e" } })), /W1-T12e/);
    assert.equal(f.calls[0]!.url, "/v1/inbox");
    assert.equal(f.calls[0]!.token, "Bearer read-scope-secret");
  } finally { await pair.close(); await f.close(); }
});

test("W1-T4679: its one write tool lands through the console's answer route", async () => {
  const f = await fixture(), pair = await connected({ ...f.config, writeToken: "write-scope-secret" });
  try {
    assert.equal((await pair.client.listTools()).tools.find(t => t.name === "answer_question")!.annotations!.readOnlyHint, false);
    assert.equal((await pair.client.callTool({ name: "answer_question", arguments: { taskId: "W1-T1", answer: "Use the isolated canary" } })).isError, undefined);
    assert.equal(f.calls[0]!.url, "/v1/questions/answer");
    assert.equal(f.calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(f.calls[0]!.body), { taskId: "W1-T1", answer: "Use the isolated canary" });
    assert.equal(f.calls[0]!.token, "Bearer write-scope-secret");
  } finally { await pair.close(); await f.close(); }
});

test("operator tools refuse writes without capability, injection, surplus arguments and empty answers", async () => {
  const f = await fixture(), pair = await connected(f.config);
  try {
    for (const [name, args] of [["answer_question", { taskId: "W1-T1", answer: "yes" }], ["case_file", { taskId: "W1-T1; touch /tmp/x" }],
      ["ledger_grep", { pattern: "x", flags: "--write" }], ["ledger_grep", { pattern: "" }], ["inbox", { extra: true }], ["approve_pr", {}]] as const)
      assert.equal((await pair.client.callTool({ name, arguments: args })).isError, true);
    assert.equal(f.calls.length, 0);
    const enabled = await connected({ ...f.config, writeToken: "write-scope-secret" });
    try { for (const answer of ["", " ", "x".repeat(16_385)]) assert.equal((await enabled.client.callTool({ name: "answer_question", arguments: { taskId: "W1-T1", answer } })).isError, true); }
    finally { await enabled.close(); }
  } finally { await pair.close(); await f.close(); }
  for (const url of ["ftp://local/", "http://user:pass@local/", "http://local/?token=x", "http://local/#x", "http://local/v1/i/site"])
    assert.throws(() => createOperatorMcpServer({ ...base, url }));
  assert.throws(() => createOperatorMcpServer({ ...base, timeoutMs: 0 }));
  assert.throws(() => createOperatorMcpServer({ ...base, readToken: "" }));
});

test("the real HTTP default preserves route refusals, caps responses and never exposes tokens", async () => {
  const f = await fixture(), pair = await connected(f.config);
  try {
    assert.equal((await pair.client.callTool({ name: "inbox" })).isError, undefined);
    f.mode("refused");
    const refused = await pair.client.callTool({ name: "inbox" });
    assert.equal(refused.isError, true);
    assert.match(content(refused), /403/);
    assert.doesNotMatch(content(refused), /read-scope-secret/);
    f.mode("large");
    assert.match(content(await pair.client.callTool({ name: "inbox" })), /1 MiB/);
  } finally { await pair.close(); await f.close(); }
});

test("the real CLI default bounds the process tree and preserves failure rather than claiming completion", async () => {
  const f = await fixture(), pair = await connected(f.config);
  try {
    assert.match(content(await pair.client.callTool({ name: "case_file", arguments: { taskId: "CONSOLE-T1" } })), /CONSOLE-T1/);
    writeFileSync(f.script, "process.stderr.write('refused'); process.exit(7);\n");
    assert.match(content(await pair.client.callTool({ name: "ledger_grep", arguments: { pattern: "x" } })), /refused/);
    writeFileSync(f.script, "process.stdout.write('x'.repeat(2 * 1024 * 1024));\n");
    assert.match(content(await pair.client.callTool({ name: "ledger_grep", arguments: { pattern: "x" } })), /1 MiB/);
    writeFileSync(f.script, "setInterval(() => {}, 100);\n");
    const short = await connected({ ...f.config, timeoutMs: 1000 });
    try { assert.match(content(await short.client.callTool({ name: "ledger_grep", arguments: { pattern: "x" } })), /timed out/); }
    finally { await short.close(); }
  } finally { await pair.close(); await f.close(); }
});

test("command setup refuses invalid options and write enablement without a write token", async () => {
  await assert.rejects(operatorMcpCommand(["--approve"], { root: "/missing" }, process.cwd()), /usage/);
  const repo = gitRepo({ kind: "mcp-tokens" });
  try {
    mkdirSync(join(repo.dir, "state"));
    writeFileSync(join(repo.dir, "state", "service-tokens.json"), JSON.stringify({ read: "read-scope-secret" }));
    await assert.rejects(operatorMcpCommand(["--enable-write"], { root: repo.dir }, repo.dir), /write-scope/);
  } finally { repo.cleanup(); }
});
