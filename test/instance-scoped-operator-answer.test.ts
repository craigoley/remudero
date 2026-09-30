import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { coldAnalyticsSnapshot, deriveAnalyticsSnapshot, type AnalyticsSnapshotCache } from "../src/lib/analytics-route.js";
import { buildInstanceGatewayRoutes } from "../src/lib/instance-gateway.js";
import { buildOperatorAgentAnswerRoute } from "../src/lib/operator-agent-answer.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const READ = "instance-answer-read";
const WRITE = "instance-answer-write";

function capacity(repo: string, workers: number, now: number): Record<string, unknown> {
  return {
    ts: new Date(now).toISOString(), step: "scheduler.capacity", repo,
    configured_capacity: workers + 1, admitted_lanes: workers + 1,
    active_workers: workers, queued_work: 2,
    window_start: new Date(now - 60_000).toISOString(), window_end: new Date(now).toISOString(),
  };
}

function fixture(t: { after: (fn: () => void) => void }, consoleSource: "measured" | "missing" | "unreadable" = "measured") {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}instance-answer-`));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const stateBase = join(base, "instances");
  const now = Date.now();
  const ledgerPaths = new Map<string, string>();
  for (const [instance, repo, workers] of [
    ["site", "remudero-site", 2], ["console", "remudero-console", 4],
  ] as const) {
    const root = join(stateBase, instance);
    const state = join(root, "state");
    const plan = join(root, "repos", repo, "plan");
    mkdirSync(state, { recursive: true });
    mkdirSync(plan, { recursive: true });
    writeFileSync(join(plan, "tasks.yaml"), "[]\n");
    const ledger = join(state, "ledger.ndjson");
    ledgerPaths.set(instance, ledger);
    if (!(instance === "console" && consoleSource === "missing")) {
      writeFileSync(ledger, JSON.stringify(capacity(`craigoley/${repo}`, workers, now)) + "\n");
    }
    if (instance === "console" && consoleSource === "unreadable") {
      writeFileSync(join(state, "ledger.2026-09-27T20-00-00-000Z.ndjson.gz"), "not a gzip archive");
    }
  }
  const registryPath = join(base, "daemon-instances.yaml");
  writeFileSync(registryPath, [
    "instances:",
    "  core:", "    repo: remudero", "    github_repo: craigoley/remudero",
    "  site:", "    repo: remudero-site", "    github_repo: craigoley/remudero-site",
    "  console:", "    repo: remudero-console", "    github_repo: craigoley/remudero-console", "",
  ].join("\n"));
  return { stateBase, registryPath, ledgerPaths, now };
}

async function withAnswers(
  t: { after: (fn: () => void) => void },
  consoleSource: "measured" | "missing" | "unreadable",
  run: (ask: (instance: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>, files: ReturnType<typeof fixture>) => Promise<void>,
): Promise<void> {
  const files = fixture(t, consoleSource);
  const caches: AnalyticsSnapshotCache[] = [];
  const core = deriveAnalyticsSnapshot([capacity("craigoley/remudero", 99, files.now)], new Date(files.now).toISOString());
  const coreRoute = buildOperatorAgentAnswerRoute(() => ({ repository: "craigoley/remudero", instance: "core", snapshot: core }));
  const routes = buildInstanceGatewayRoutes([coreRoute], {
    registryPath: files.registryPath, stateBase: files.stateBase,
    onAnalyticsCache: (cache) => caches.push(cache),
  });
  assert.equal(caches.length, 2, "each non-core instance owns a distinct analytics cache");
  await Promise.all(caches.map((cache) => cache.refresh()));
  const server = createService({ tokens: { read: READ, write: WRITE }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ask = async (instance: string, body: unknown) => {
      const response = await fetch(`${base}/v1/i/${instance}/operator-agent/ask`, {
        method: "POST", headers: { authorization: `Bearer ${READ}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    await run(ask, files);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const cache of caches) cache.stop();
  }
}

test("instance gateway answers site and console from their own evidence", async (t) => {
  await withAnswers(t, "measured", async (ask, files) => {
    const before = [...files.ledgerPaths.values()].map((path) => readFileSync(path, "utf8"));
    const core = await ask("core", { question: "What is worker capacity?" });
    const site = await ask("site", { question: "What is worker capacity?" });
    const consoleAnswer = await ask("console", { question: "What is worker capacity?" });
    assert.equal(core.status, 200);
    assert.equal(site.status, 200);
    assert.equal(consoleAnswer.status, 200);
    assert.equal(core.body.repository, "craigoley/remudero");
    assert.equal(site.body.repository, "craigoley/remudero-site");
    assert.equal(consoleAnswer.body.repository, "craigoley/remudero-console");
    assert.equal(site.body.instance, "site");
    assert.equal(consoleAnswer.body.instance, "console");
    assert.match(String(core.body.answer), /99 of 100 workers/);
    assert.match(String(site.body.answer), /2 of 3 workers/);
    assert.match(String(consoleAnswer.body.answer), /4 of 5 workers/);
    assert.equal(site.body.coverage, "verified");
    assert.equal(consoleAnswer.body.coverage, "verified");
    assert.deepEqual([...files.ledgerPaths.values()].map((path) => readFileSync(path, "utf8")), before, "answer requests cannot write to the ledgers");
  });
});

test("instance answer rejects forged repository scope and core fallback", async (t) => {
  await withAnswers(t, "measured", async (ask) => {
    const forged = await ask("site", { question: "What is worker capacity?", repository: "craigoley/remudero" });
    assert.equal(forged.status, 400);
    const wrongQuestion = await ask("site", { question: "What is worker capacity in craigoley/remudero?" });
    assert.equal(wrongQuestion.body.coverage, "unsupported");
    assert.doesNotMatch(JSON.stringify(wrongQuestion.body), /99 of 100 workers/);
    const unknown = await ask("unknown", { question: "What is worker capacity?" });
    assert.equal(unknown.status, 404);
  });
});

test("instance answer names missing evidence instead of inventing a complete answer", async (t) => {
  await withAnswers(t, "missing", async (ask) => {
    const site = await ask("site", { question: "What is worker capacity?" });
    const missing = await ask("console", { question: "What is worker capacity?" });
    assert.equal(site.body.coverage, "verified", "positive control: the same reader sees the site's ledger");
    assert.equal(missing.status, 200);
    assert.equal(missing.body.coverage, "unavailable");
    assert.equal(missing.body.repository, "craigoley/remudero-console");
    assert.deepEqual(missing.body.citations, []);
    assert.ok((missing.body.missingSources as Array<{ reason: string }>).some((source) => /ledger-source-missing/.test(source.reason)));
    assert.ok(Number.isFinite(Date.parse(String(missing.body.generatedAt))));
  });
});

test("an unreadable instance archive cannot turn an incomplete measurement into verified coverage", async (t) => {
  await withAnswers(t, "unreadable", async (ask) => {
    const response = await ask("console", { question: "What is worker capacity?" });
    assert.equal(response.status, 200);
    assert.equal(response.body.coverage, "unavailable");
    assert.deepEqual(response.body.citations, []);
    assert.ok((response.body.missingSources as Array<{ reason: string }>).some((source) => /ledger-source-unreadable/.test(source.reason)));
  });
});

test("instance answer route is mounted read-only with an OpenAPI declaration", async (t) => {
  const files = fixture(t);
  const routes = buildInstanceGatewayRoutes([], { registryPath: files.registryPath, stateBase: files.stateBase });
  const route = routes.find((item) => item.path === "/v1/i/site/operator-agent/ask" && item.method === "POST");
  assert.ok(route);
  assert.equal(route.scope, "read");
  const openapi = readFileSync(join(import.meta.dirname, "..", "openapi", "daemon.yaml"), "utf8");
  assert.match(openapi, /^  \/v1\/i\/\{instance\}\/operator-agent\/ask:/m);
  assert.equal(coldAnalyticsSnapshot().asOf, null, "a newly mounted cache starts cold, not with core evidence");
});
