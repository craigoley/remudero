import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { coldAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { buildOperatorAgentAnswerRoute } from "../src/lib/operator-agent-answer.js";
import { createService } from "../src/lib/service.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const READ = "operator-answer-read";
const WRITE = "operator-answer-write";

async function serve<T>(routes: ReturnType<typeof buildServeRoutes>, action: (base: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ, write: WRITE }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await action(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function ask(base: string, token: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/operator-agent/ask`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test("agent ask route rejects oversized and forged repository scope", async () => {
  const route = buildOperatorAgentAnswerRoute(() => ({ repository: "owner/repo", instance: "core", snapshot: coldAnalyticsSnapshot() }));
  await serve([route], async (base) => {
    assert.equal((await ask(base, undefined, { question: "proof?" })).status, 401);
    assert.equal((await ask(base, READ, { question: "x".repeat(501) })).status, 400);
    assert.equal((await ask(base, READ, { question: "proof?", repository: "other/repo" })).status, 400);
    assert.equal((await ask(base, READ, { question: "proof?", instance: "other" })).status, 400);
    const response = await ask(base, READ, { question: "proof?" });
    assert.equal(response.status, 200);
    const body = await response.json() as { version: string; repository: string; coverage: string };
    assert.equal(body.version, "answer-v1");
    assert.equal(body.repository, "owner/repo");
    assert.equal(body.coverage, "unavailable", "cold evidence cannot become a verified answer");
  });
});

test("agent ask route leaves proposal task and ledger writes unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}agent-answer-route-`));
  try {
    const planPath = join(root, "plan", "tasks.yaml");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const proposalPath = join(root, "state", "inbox-proposals.json");
    mkdirSync(join(root, "plan"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(planPath, "[]\n");
    writeFileSync(ledgerPath, "seed\n");
    writeFileSync(proposalPath, "[]\n");
    const before = [planPath, ledgerPath, proposalPath].map((path) => readFileSync(path, "utf8"));
    const plan = { tasks: [], byId: new Map() };
    const deps: ServeDeps = {
      board: { plan, ledgerPath, github: fakeGitHub() },
      panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} } },
      ledgerPath, issues: { close: () => {} }, fleetControlRoot: root, questionsRoot: root,
      tokens: { read: READ, write: WRITE }, githubEventWake: { repository: "owner/repo" },
    };
    const assembled = buildServeRoutes(deps);
    const askRoute = assembled.find((route) => route.method === "POST" && route.path === "/v1/operator-agent/ask");
    assert.ok(askRoute, "the actual serve route assembly mounts the answer route");
    assert.equal(askRoute.scope, "read");
    await serve([askRoute], async (base) => {
      const response = await ask(base, READ, { question: "What are proof failures?" });
      assert.equal(response.status, 200);
      const body = await response.json() as { repository: string; instance: string; coverage: string; citations: unknown[] };
      assert.equal(body.repository, "owner/repo");
      assert.equal(body.instance, "core");
      assert.equal(body.coverage, "unavailable");
      assert.deepEqual(body.citations, []);
    });
    assert.deepEqual([planPath, ledgerPath, proposalPath].map((path) => readFileSync(path, "utf8")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
