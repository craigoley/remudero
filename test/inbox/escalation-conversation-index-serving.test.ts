import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildServeServer, stopServeReadModel, type ServeDeps } from "#src/lib/serve.js";
import { appendThreadMessage, appendThreadReplyOnce } from "#src/lib/inbox-thread.js";
import type { EscalationConversationIndex } from "#src/lib/escalation-conversation-index.js";
import type { EscalationConversationRead } from "#src/lib/escalation-conversation.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

test("assembled service serves the repository scoped engineering conversation index", async t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-escalation-mailbox-serving-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const coreRoot = join(root, "core"), stateBase = join(root, "instances"), siteRoot = join(stateBase, "site");
  function source(stateRoot: string, name: string, taskId: string, issueNumber: number) {
    const repository = `craigoley/${name}`, issueUrl = `https://github.com/${repository}/issues/${issueNumber}`;
    const stateDir = join(stateRoot, "state"), checkout = join(stateRoot, "repos", name), planPath = join(checkout, "plan", "tasks.yaml");
    mkdirSync(stateDir, { recursive: true }); mkdirSync(join(checkout, "plan"), { recursive: true });
    const ledgerPath = join(stateDir, "ledger.ndjson"), threadStorePath = join(stateDir, "inbox-threads.jsonl");
    writeFileSync(planPath, "[]\n"); writeFileSync(ledgerPath, "");
    const identity = { taskId, class: "MANUAL", cause: "stage-stall", prRef: "15520" };
    appendThreadMessage(identity, "escalation", "PR #15520 needs clarification\n\nPR #15520 is stalled.", { threadStorePath });
    appendThreadReplyOnce(identity, `Investigate ${name} first.`, `mailbox-${name}-answer`, { threadStorePath },
      { escalation: { issueUrl, revision: "a".repeat(64) } });
    return { repository, issueUrl, identity, stateRoot, checkout, planPath, ledgerPath, threadStorePath };
  }
  const core = source(coreRoot, "remudero", "W1-T42", 16183), site = source(siteRoot, "remudero-site", "SITE-T1", 1);
  const registryPath = join(root, "registry.yaml");
  writeFileSync(registryPath, "instances:\n  core:\n    repo: remudero\n    github_repo: craigoley/remudero\n    project: remudero\n    state_dir: /fixture/core\n  site:\n    repo: remudero-site\n    github_repo: craigoley/remudero-site\n    project: remudero\n    state_dir: /fixture/site\n");
  const reads: string[] = [];
  const readIssue = async (url: string) => {
    reads.push(url); const own = url === site.issueUrl ? site : core;
    return { html_url: url, title: `[MANUAL] ${own.identity.taskId}: PR #15520 needs clarification`, state: "open",
      updated_at: "2026-11-02T12:00:00Z", body: `**Class:** MANUAL\n**Task:** ${own.identity.taskId}\n**Cause:** stage-stall\n\nPR #15520 is stalled.\n\n## Options\n- **Investigate** — Find the cause.\n\n## Recommendation\nInvestigate first.` };
  };
  const github = fakeGitHub();
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath: core.ledgerPath, github },
    panelGraph: { root: core.checkout, planPath: core.planPath, ledgerPath: core.ledgerPath,
      github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath: core.ledgerPath, issues: { close() { assert.fail("Mailbox interactions never close an escalation"); } },
    fleetControlRoot: coreRoot, questionsRoot: core.checkout, assistantRepository: core.repository,
    tokens: { read: "fixture-read", write: "fixture-write" }, pollMs: 60_000,
    consoleSha: "f".repeat(40), resolveCurrentSha: () => "f".repeat(40),
    githubAppRefresh: { start: () => ({ armed: false }) }, daemonHealth: { exec: () => "{}" },
    escalationConversation: { readIssue },
    instances: { registryPath, stateBase, coreInstance: "core", github: () => github, escalationConversation: { readIssue } },
  };
  const server = buildServeServer(deps);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = (path: string, authenticated = true) => fetch(base + path, { headers: authenticated ? { authorization: "Bearer fixture-read" } : {} });
    const denied = await get("/v1/i/site/escalation/threads", false); assert.equal(denied.status, 401); await denied.arrayBuffer();
    for (const [prefix, own] of [["/v1", core], ["/v1/i/core", core], ["/v1/i/site", site]] as const) {
      const response = await get(`${prefix}/escalation/threads`); assert.equal(response.status, 200);
      const index = await response.json() as EscalationConversationIndex; assert.ok(index.state === "served");
      assert.equal(index.repository, own.repository); assert.equal(index.items.length, 1);
      assert.equal(index.items[0]!.issueUrl, own.issueUrl); assert.equal(index.items[0]!.attention, "waiting_for_agent");
    }
    assert.equal(reads.length, 0, "Listing saved conversations must not fan out to issue reads");
    const unknown = await get("/v1/i/not-registered/escalation/threads"); assert.equal(unknown.status, 404); await unknown.arrayBuffer();
    const badFolder = await get("/v1/i/site/escalation/threads?folder=approve"); assert.equal(badFolder.status, 400); await badFolder.arrayBuffer();
    const foreign = await get(`/v1/i/site/escalation/thread?issueUrl=${encodeURIComponent(core.issueUrl)}`);
    assert.equal(foreign.status, 404); await foreign.arrayBuffer(); assert.equal(reads.length, 0);
    const detail = await get(`/v1/i/site/escalation/thread?issueUrl=${encodeURIComponent(site.issueUrl)}`);
    assert.equal(detail.status, 200); const body = await detail.json() as EscalationConversationRead; assert.ok(body.state === "served");
    const before = readFileSync(core.threadStorePath, "utf8");
    const reply = await fetch(`${base}/v1/i/site/escalation/reply`, { method: "POST", headers: {
      authorization: "Bearer fixture-write", "content-type": "application/json" }, body: JSON.stringify({ ...site.identity,
      issueUrl: site.issueUrl, expectedRevision: body.conversation.revision, intentId: "site-second-answer-001", text: "Compare the two versions." }) });
    assert.equal(reply.status, 200); const saved = await reply.json() as { saved: { seq: number; text: string }; work: string };
    assert.equal(saved.saved.seq, 3); assert.equal(saved.saved.text, "Compare the two versions."); assert.equal(saved.work, "not_observed");
    assert.equal(readFileSync(core.threadStorePath, "utf8"), before);
    assert.match(readFileSync(site.threadStorePath, "utf8"), /Compare the two versions/);
  } finally {
    stopServeReadModel(server); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
