/**
 * @source-text-subject: the final production-wiring check asserts the CLI assembler's source text.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  classifyGithubEventWake,
  createDeliveryDedupStore,
  createGitHubEventWakeHandler,
  sweepWakeMarkerPath,
  type GithubEventWakeSemanticSummary,
  type SweepWakeMarker,
} from "../src/lib/github-event-wake.js";
import { createService, type Route } from "../src/lib/service.js";
import { loadPolicy, policyPath, PolicyError, validatePolicy } from "../src/lib/policy.js";

const SECRET = "test-webhook-secret";
const REPOSITORY = "craigoley/remudero";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function signature(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

function webhookHeaders(body: string, deliveryId: string, event = "check_run"): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": event,
    "x-hub-signature-256": signature(body),
  };
}

function checkRunBody(name: unknown, conclusion: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "completed",
    repository: { full_name: REPOSITORY },
    check_run: { name, conclusion },
    ...extra,
  });
}

async function withRoute<T>(route: Route, run: (url: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: "read", write: "write" }, routes: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await run(`http://127.0.0.1:${port}${route.path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function summary(entry: { extra?: Record<string, unknown> }): GithubEventWakeSemanticSummary {
  return entry.extra?.semantic_check_summary as GithubEventWakeSemanticSummary;
}

function shippedPolicyRaw(): Record<string, unknown> {
  return parseYaml(readFileSync(policyPath(REPO_ROOT), "utf8")) as Record<string, unknown>;
}

function assertPolicyError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof PolicyError && pattern.test((e as Error).message));
}

test("classifier keeps structural and status events actionable, wakes for aggregate/failure checks, suppresses only successful leaves, and wakes on unknown payloads", () => {
  const aggregates = ["ci-gate", "ci"];

  assert.deepEqual(classifyGithubEventWake("pull_request", "synchronize", {}, aggregates), {
    class: "actionable",
    actionable: true,
  });
  assert.deepEqual(classifyGithubEventWake("status", undefined, {}, aggregates), {
    class: "actionable",
    actionable: true,
  });
  assert.deepEqual(
    classifyGithubEventWake("check_run", "completed", JSON.parse(checkRunBody("ci-gate", "success")), aggregates),
    { class: "actionable_aggregate", actionable: true, aggregateName: "ci-gate" },
  );
  assert.deepEqual(
    classifyGithubEventWake("check_run", "completed", JSON.parse(checkRunBody("lint", "failure")), aggregates),
    { class: "actionable_failure", actionable: true },
  );
  assert.deepEqual(
    classifyGithubEventWake("check_run", "completed", JSON.parse(checkRunBody("lint", "success")), aggregates),
    { class: "successful_leaf", actionable: false },
  );
  assert.deepEqual(
    classifyGithubEventWake("check_run", "completed", JSON.parse(checkRunBody("lint", "mystery")), aggregates),
    { class: "unknown", actionable: true },
  );
  assert.deepEqual(
    classifyGithubEventWake("check_run", "completed", JSON.parse(checkRunBody(undefined, "success")), aggregates),
    { class: "unknown", actionable: true },
  );
});

test("shadow mode writes a marker for every currently accepted check while emitting bounded class counts on accepted rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-shadow-leaf-"));
  const markerPath = sweepWakeMarkerPath(root);
  const writes: SweepWakeMarker[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: REPOSITORY,
    markerPath,
    dedup: createDeliveryDedupStore(10),
    semanticCheckMode: "shadow",
    aggregateCheckNames: ["ci-gate", "ci"],
    writeMarker: (_path, record) => writes.push(record),
    log: (step, extra) => logs.push({ step, extra }),
  });

  try {
    await withRoute(route, async (url) => {
      for (const [delivery, body] of [
        ["leaf", checkRunBody("eslint", "success")],
        ["aggregate", checkRunBody("ci-gate", "success")],
        ["failure", checkRunBody("scanner", "timed_out")],
      ] as const) {
        const response = await fetch(url, { method: "POST", headers: webhookHeaders(body, delivery), body });
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { accepted: true });
      }
    });

    assert.deepEqual(writes.map((record) => record.deliveryId), ["leaf", "aggregate", "failure"]);
    assert.deepEqual(logs.map((entry) => entry.step), [
      "github.wake.accepted",
      "github.wake.accepted",
      "github.wake.accepted",
    ]);
    assert.deepEqual(summary(logs[0]), {
      mode: "shadow",
      actionable_failure: 0,
      actionable_aggregate: 0,
      successful_leaf: 1,
      unknown: 0,
      aggregate_names: { "ci-gate": 0, ci: 0 },
    });
    assert.deepEqual(summary(logs[1]), {
      mode: "shadow",
      actionable_failure: 0,
      actionable_aggregate: 1,
      successful_leaf: 0,
      unknown: 0,
      aggregate_names: { "ci-gate": 1, ci: 0 },
    });
    assert.deepEqual(summary(logs[2]), {
      mode: "shadow",
      actionable_failure: 1,
      actionable_aggregate: 0,
      successful_leaf: 0,
      unknown: 0,
      aggregate_names: { "ci-gate": 0, ci: 0 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enforce mode suppresses successful leaves without a marker, while aggregate, failure, status and unknown controls still write one marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-enforce-leaf-"));
  const writes: SweepWakeMarker[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const route = createGitHubEventWakeHandler({
    secret: SECRET,
    repository: REPOSITORY,
    markerPath: sweepWakeMarkerPath(root),
    dedup: createDeliveryDedupStore(10),
    semanticCheckMode: "enforce",
    aggregateCheckNames: ["ci-gate", "ci"],
    writeMarker: (_path, record) => writes.push(record),
    log: (step, extra) => logs.push({ step, extra }),
  });

  try {
    await withRoute(route, async (url) => {
      const leaf = checkRunBody("eslint", "success");
      const leafResponse = await fetch(url, { method: "POST", headers: webhookHeaders(leaf, "leaf"), body: leaf });
      assert.equal(leafResponse.status, 202);
      assert.deepEqual(await leafResponse.json(), { accepted: false, reason: "successful_leaf" });
      assert.deepEqual(writes, []);

      const aggregate = checkRunBody("ci-gate", "success");
      const aggregateResponse = await fetch(url, {
        method: "POST",
        headers: webhookHeaders(aggregate, "aggregate"),
        body: aggregate,
      });
      assert.equal(aggregateResponse.status, 202);
      assert.deepEqual(await aggregateResponse.json(), { accepted: true });

      const failure = checkRunBody("scanner", "action_required");
      const failureResponse = await fetch(url, {
        method: "POST",
        headers: webhookHeaders(failure, "failure"),
        body: failure,
      });
      assert.equal(failureResponse.status, 202);
      assert.deepEqual(await failureResponse.json(), { accepted: true });

      const status = JSON.stringify({ repository: { full_name: REPOSITORY } });
      const statusResponse = await fetch(url, {
        method: "POST",
        headers: webhookHeaders(status, "status", "status"),
        body: status,
      });
      assert.equal(statusResponse.status, 202);
      assert.deepEqual(await statusResponse.json(), { accepted: true });

      const unknown = JSON.stringify({
        action: "completed",
        repository: { full_name: REPOSITORY },
        check_run: { name: "scanner", conclusion: "mystery" },
      });
      const unknownResponse = await fetch(url, {
        method: "POST",
        headers: webhookHeaders(unknown, "unknown"),
        body: unknown,
      });
      assert.equal(unknownResponse.status, 202);
      assert.deepEqual(await unknownResponse.json(), { accepted: true });
    });

    assert.deepEqual(writes.map((record) => record.deliveryId), ["aggregate", "failure", "status", "unknown"]);
    assert.deepEqual(summary(logs[0]), {
      mode: "enforce",
      actionable_failure: 0,
      actionable_aggregate: 1,
      successful_leaf: 1,
      unknown: 0,
      aggregate_names: { "ci-gate": 1, ci: 0 },
    });
    assert.deepEqual(summary(logs[1]), {
      mode: "enforce",
      actionable_failure: 1,
      actionable_aggregate: 0,
      successful_leaf: 0,
      unknown: 0,
      aggregate_names: { "ci-gate": 0, ci: 0 },
    });
    assert.equal(summary(logs[2]), undefined);
    assert.deepEqual(summary(logs[3]), {
      mode: "enforce",
      actionable_failure: 0,
      actionable_aggregate: 0,
      successful_leaf: 0,
      unknown: 1,
      aggregate_names: { "ci-gate": 0, ci: 0 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fork-shaped check payload with empty pull_requests is classified from name and conclusion", () => {
  const body = JSON.parse(checkRunBody("eslint", "skipped", { pull_requests: [] }));
  assert.deepEqual(classifyGithubEventWake("check_run", "completed", body, ["ci-gate", "ci"]), {
    class: "successful_leaf",
    actionable: false,
  });
});

test("policy rejects bad semantic check rows and ships shadow with ci-gate and ci configured", () => {
  const shipped = loadPolicy(policyPath(REPO_ROOT));
  assert.equal(shipped.values.githubEventWake.semanticCheckMode, "shadow");
  assert.deepEqual(shipped.values.githubEventWake.aggregateCheckNames, ["ci-gate", "ci"]);

  const unknownMode = shippedPolicyRaw();
  (((unknownMode.githubEventWake as Record<string, unknown>).semanticCheckMode as Record<string, unknown>).value) = "observe";
  assertPolicyError(() => validatePolicy(unknownMode), /semanticCheckMode\.value.*shadow.*enforce/);

  const emptyList = shippedPolicyRaw();
  (((emptyList.githubEventWake as Record<string, unknown>).aggregateCheckNames as Record<string, unknown>).value) = [];
  assertPolicyError(() => validatePolicy(emptyList), /aggregateCheckNames\.value.*non-empty string array/);

  const nonStringName = shippedPolicyRaw();
  (((nonStringName.githubEventWake as Record<string, unknown>).aggregateCheckNames as Record<string, unknown>).value) = [
    "ci-gate",
    42,
  ];
  assertPolicyError(() => validatePolicy(nonStringName), /aggregateCheckNames\.value\[1\].*non-empty string/);
});

test("production Serve threads committed semantic mode and aggregate names without moving the secret boundary or adding a GitHub client", () => {
  const serveSource = readFileSync(new URL("../src/lib/serve.ts", import.meta.url), "utf8");
  const runTaskSource = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

  assert.match(serveSource, /secret:\s*deps\.githubEventWake\?\.secret/);
  assert.match(serveSource, /semanticCheckMode:\s*deps\.githubEventWake\?\.semanticCheckMode/);
  assert.match(serveSource, /aggregateCheckNames:\s*deps\.githubEventWake\?\.aggregateCheckNames/);
  assert.match(runTaskSource, /semanticCheckMode:\s*githubEventWakePolicy\?\.values\.githubEventWake\.semanticCheckMode/);
  assert.match(runTaskSource, /aggregateCheckNames:\s*githubEventWakePolicy\?\.values\.githubEventWake\.aggregateCheckNames/);
  assert.doesNotMatch(serveSource, /githubEventWake\?:\s*\{[^}]*github:/s);
});
