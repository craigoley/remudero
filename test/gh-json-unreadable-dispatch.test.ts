import assert from "node:assert/strict";
import { test } from "node:test";
import { GhJsonUnreadableResponseError, ghJson, ghJsonAsync } from "../src/lib/github-transport.js";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import type { MergedSet } from "../src/lib/drain.js";

const NONE_MERGED: MergedSet = () => false;

function onePlan(): Plan {
  return loadPlanFromYaml(
    `
- id: W1-T3791-fixture
  title: unreadable response fixture
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`,
    "json-unreadable-dispatch.fixture.yaml",
  );
}

async function captureUnreadable(body: string): Promise<GhJsonUnreadableResponseError> {
  const result = await ghJsonAsync(["api", "repos/o/r", "-f", "token=fixture-secret"], async () => ({ stdout: body, stderr: "" })).catch((error: unknown) => error);
  assert.ok(result instanceof GhJsonUnreadableResponseError);
  return result;
}

function captureUnreadableSync(body: string): GhJsonUnreadableResponseError {
  try {
    ghJson(["api", "repos/o/r", "-f", "token=fixture-secret"], undefined, () => body);
  } catch (error) {
    assert.ok(error instanceof GhJsonUnreadableResponseError);
    return error;
  }
  assert.fail("expected ghJson to reject an unreadable response");
}

async function runRejected(error: unknown): Promise<Awaited<ReturnType<typeof runDaemon>>> {
  return runDaemon(
    onePlan(),
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => {
        throw error;
      },
      sleep: async () => {},
    },
    { max: 1, pollIntervalMs: 1 },
  );
}

test("ghJsonAsync names a successful but unreadable JSON body", async () => {
  for (const body of ["", "{malformed"]) {
    const error = await captureUnreadable(body);
    assert.equal(error.name, "GhJsonUnreadableResponseError");
    assert.equal(error.reasonClass, "gh_json_unreadable_response");
    assert.equal(error.operation, "api");
    assert.match(error.message, /gh api response body was unreadable/);
    if (body === "") assert.equal((error.cause as SyntaxError).message, "Unexpected end of JSON input");
    else assert.match((error.cause as SyntaxError).message, /Expected property name or '\}' in JSON at position 1/);
  }
});

test("ghJson names a successful but unreadable JSON body", () => {
  for (const body of ["", "{malformed"]) {
    const error = captureUnreadableSync(body);
    assert.equal(error.reasonClass, "gh_json_unreadable_response");
    assert.equal(error.operation, "api");
    assert.match(error.message, /gh api response body was unreadable/);
  }
});

test("runDaemon defers a typed unreadable gh response", async () => {
  const error = captureUnreadableSync("");
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const summary = await runDaemon(
    onePlan(),
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => {
        throw error;
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1, pollIntervalMs: 1 },
  );

  assert.equal(summary.stopReason, "max_reached");
  assert.equal(lines.filter((line) => line.step === "daemon.dispatch_transport_deferred").length, 1);
  assert.equal(lines.some((line) => line.step === "daemon.summary" && line.extra.stopReason === "error"), false);
});

test("unreadable gh response deferral excludes 404 and arbitrary SyntaxError", async () => {
  const notFoundSummary = await runRejected(new Error("gh: HTTP 404 Not Found"));
  assert.equal(notFoundSummary.stopReason, "error");
  assert.match(notFoundSummary.stopDetail ?? "", /HTTP 404/);

  const syntaxSummary = await runRejected(new SyntaxError("Unexpected end of JSON input"));
  assert.equal(syntaxSummary.stopReason, "error");
  assert.match(syntaxSummary.stopDetail ?? "", /Unexpected end of JSON input/);
});

test("unreadable gh response ledger evidence is bounded and secret-free", async () => {
  const error = captureUnreadableSync("");
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const summary = await runDaemon(
    onePlan(),
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => {
        throw error;
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1, pollIntervalMs: 1 },
  );

  const deferred = lines.find((line) => line.step === "daemon.dispatch_transport_deferred");
  assert.ok(deferred);
  const evidence = JSON.stringify(deferred?.extra);
  assert.match(evidence, /gh api response body was unreadable/);
  assert.doesNotMatch(evidence, /fixture-secret|Unexpected end of JSON input/);
  assert.equal(summary.stopReason, "max_reached");
});
