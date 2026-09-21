import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  createDeliveryDedupStore,
  createGitHubEventWakeHandler,
  type GithubEventWakeSemanticSummary,
} from "../src/lib/github-event-wake.js";
import { createService } from "../src/lib/service.js";
import { loadPolicy, policyPath, PolicyError, validatePolicy } from "../src/lib/policy.js";

const SECRET = "contract-secret";
const REPOSITORY = "craigoley/remudero";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function policyRaw(): Record<string, unknown> {
  return parseYaml(readFileSync(policyPath(REPO_ROOT), "utf8")) as Record<string, unknown>;
}

function assertPolicyError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => error instanceof PolicyError && pattern.test((error as Error).message));
}

function checkRunBody(name: string, headSha: unknown): string {
  return JSON.stringify({
    action: "completed",
    repository: { full_name: REPOSITORY },
    check_run: { name, conclusion: "success", head_sha: headSha },
  });
}

function headers(body: string, deliveryId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": "check_run",
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`,
  };
}

async function withRoute<T>(route: ReturnType<typeof createGitHubEventWakeHandler>, run: (url: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await run(`http://127.0.0.1:${port}${route.path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("W1-T3973 criterion 4: webhook enforce requires complete ratification", () => {
  const raw = policyRaw();
  (((raw.githubEventWake as Record<string, unknown>).semanticCheckMode as Record<string, unknown>).value) = "enforce";
  assertPolicyError(() => validatePolicy(raw), /enforceRatification.*required/);

  (raw.githubEventWake as Record<string, unknown>).enforceRatification = {
    value: {
      observedFrom: "2026-09-19T00:00:00Z",
      observedThrough: "2026-09-20T00:00:00Z",
      ratifiedAt: "2026-09-21T00:00:00Z",
      aggregateHeadsCovered: 12,
      aggregateHeadsTotal: 12,
    },
    origin: "net-new",
  };
  const policy = validatePolicy(raw);
  assert.equal(policy.values.githubEventWake.semanticCheckMode, "enforce");
  assert.equal(policy.values.githubEventWake.enforceRatification?.aggregateHeadsCovered, 12);
});

test("webhook enforce refuses incomplete ratification", () => {
  const cases = [
    { name: "partial", from: "2026-09-19T06:00:00Z", through: "2026-09-20T00:00:00Z", covered: 12, total: 12 },
    { name: "sub-day", from: "2026-09-19T00:00:00Z", through: "2026-09-19T12:00:00Z", covered: 12, total: 12 },
    { name: "uncovered", from: "2026-09-19T00:00:00Z", through: "2026-09-20T00:00:00Z", covered: 11, total: 12 },
  ];
  for (const candidate of cases) {
    const raw = policyRaw();
    (((raw.githubEventWake as Record<string, unknown>).semanticCheckMode as Record<string, unknown>).value) = "enforce";
    (raw.githubEventWake as Record<string, unknown>).enforceRatification = {
      value: {
        observedFrom: candidate.from,
        observedThrough: candidate.through,
        ratifiedAt: "2026-09-21T00:00:00Z",
        aggregateHeadsCovered: candidate.covered,
        aggregateHeadsTotal: candidate.total,
      },
      origin: "net-new",
    };
    assertPolicyError(() => validatePolicy(raw), new RegExp(candidate.name === "uncovered" ? "cover every observed" : "full UTC day|UTC midnight"));
  }
  assert.equal(loadPolicy(policyPath(REPO_ROOT)).values.githubEventWake.semanticCheckMode, "shadow");
});

test("webhook summaries preserve bounded head identity", async () => {
  const logs: Array<{ extra?: Record<string, unknown> }> = [];
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: REPOSITORY,
    markerPath: "/tmp/not-used-by-test",
    dedup: createDeliveryDedupStore(10),
    semanticCheckMode: "shadow",
    aggregateCheckNames: ["ci-gate"],
    writeMarker: () => undefined,
    log: (_step, extra) => logs.push({ extra }),
  });
  const headSha = "a".repeat(40);
  await withRoute(route, async (url) => {
    for (const [id, body] of [
      ["head", checkRunBody("ci-gate", headSha)],
      ["missing", checkRunBody("ci-gate", undefined)],
    ] as const) {
      const response = await fetch(url, { method: "POST", headers: headers(body, id), body });
      assert.equal(response.status, 202);
    }
  });
  const first = logs[0].extra?.semantic_check_summary as GithubEventWakeSemanticSummary;
  const second = logs[1].extra?.semantic_check_summary as GithubEventWakeSemanticSummary;
  assert.deepEqual(first.aggregate_head_shas, [headSha]);
  assert.equal(first.aggregate_head_sha_missing, 0);
  assert.equal(second.aggregate_head_sha_missing, 1);
  assert.equal(second.aggregate_head_sha_overflow, 0);
});
