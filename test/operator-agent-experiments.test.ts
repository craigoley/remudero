import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { writeFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import {
  buildOperatorAgentRoutes,
  OPERATOR_AGENT_EXPERIMENT_STEP,
  type OperatorAgentExperiment,
} from "../src/lib/operator-agent.js";

const READ_TOKEN = "experiment-read-token";
const WRITE_TOKEN = "experiment-write-token";
const NOW = "2026-09-20T10:00:00.000Z";

function fixture(id = "experiment:repo:worker-pool"): { ledgerPath: string; experiment: OperatorAgentExperiment } {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-experiment-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return {
    ledgerPath: join(root, "state", "ledger.ndjson"),
    experiment: {
      version: "experiment-v1",
      experimentId: id,
      proposalId: "operator-agent:repo:scale:queue-pressure",
      hypothesis: "Increasing the worker pool will reduce queue latency for the repository's worker tasks.",
      intervention: {
        summary: "Increase the worker pool from 2 to 4 for one observation window.",
        plan: "Apply the scoped worker-pool setting and restore it if the regression guard fires.",
        taskId: "W1-T3853",
        prUrl: "https://github.com/craigoley/remudero/pull/6221",
      },
      scope: {
        repo: "owner/repo",
        taskType: "worker",
        lane: "main",
        evidenceAnchors: ["ledger:queue-latency", "ledger:worker-utilization"],
      },
      baseline: {
        metricName: "queue_latency_p50",
        value: 8,
        unit: "minutes",
        denominator: 20,
        comparisonPopulation: "owner/repo worker tasks on main",
        windowStart: "2026-09-18T10:00:00.000Z",
        windowEnd: "2026-09-20T10:00:00.000Z",
        source: "ledger:queue-latency",
        freshness: "verified",
      },
      rollback: {
        plan: "Restore worker pool size to 2 and record the deployment receipt.",
        reason: "Rollback if queue latency or task failure rate regresses.",
        receipt: "change:worker-pool-restore",
      },
      createdAt: "2026-09-20T10:00:00.000Z",
      state: "proposed",
    },
  };
}

async function withService<T>(ledgerPath: string, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: buildOperatorAgentRoutes({ ledgerPath, now: () => Date.parse(NOW) }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(base: string): Promise<Response> {
  return fetch(`${base}/v1/operator-agent/experiments`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
}

async function approve(base: string, experiment: OperatorAgentExperiment): Promise<void> {
  assert.equal((await post(base, "/v1/operator-agent/experiments", { experiment })).status, 201);
  assert.equal((await post(base, "/v1/operator-agent/experiments/decision", { experimentId: experiment.experimentId, decision: "approved" })).status, 200);
}

test("unit test: self-improvement experiment refuses an incomplete hypothesis baseline window or rollback", async () => {
  const { ledgerPath, experiment } = fixture();
  await withService(ledgerPath, async (base) => {
    const malformed = [
      { experiment: { ...experiment, hypothesis: "" } },
      { experiment: { ...experiment, baseline: undefined } },
      { experiment: { ...experiment, baseline: { ...experiment.baseline, windowStart: experiment.baseline.windowEnd } } },
      { experiment: { ...experiment, rollback: undefined } },
      { experiment: { ...experiment, version: "experiment-v0" } },
    ];
    for (const body of malformed) assert.equal((await post(base, "/v1/operator-agent/experiments", body)).status, 400);
  });
  assert.equal(existsSync(ledgerPath), false);
});

test("unit test: accepting a self-improvement experiment leaves outcome unmeasured until a later observation", async () => {
  const { ledgerPath, experiment } = fixture();
  await withService(ledgerPath, async (base) => {
    await approve(base, experiment);
    const history = (await (await get(base)).json()) as { experiments: Array<{ state: string; outcome?: unknown; events: unknown[] }> };
    assert.equal(history.experiments[0]?.state, "approved");
    assert.equal(history.experiments[0]?.outcome, undefined);
    assert.equal(history.experiments[0]?.events.length, 1);
  });
  assert.deepEqual(readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).step), [
    OPERATOR_AGENT_EXPERIMENT_STEP,
    "panel.operator_agent_experiment_decision",
  ]);
});

test("unit test: self-improvement experiment reports unmeasurable instead of a success rate", async () => {
  const cases = [
    { suffix: "small-denominator", outcome: { state: "succeeded", denominator: 1, attribution: "complete", freshness: "verified" } },
    { suffix: "stale-source", outcome: { state: "succeeded", denominator: 20, attribution: "complete", freshness: "stale" } },
    { suffix: "mixed-attribution", outcome: { state: "succeeded", denominator: 20, attribution: "mixed", freshness: "verified" } },
  ] as const;
  for (const item of cases) {
    const { ledgerPath, experiment } = fixture(`experiment:repo:${item.suffix}`);
    await withService(ledgerPath, async (base) => {
      await approve(base, experiment);
      const response = await post(base, "/v1/operator-agent/experiments/outcome", {
        experimentId: experiment.experimentId,
        outcome: {
          ...item.outcome,
          summary: "The intervention appears to have improved queue latency.",
          observedAt: NOW,
          source: "ledger:queue-latency",
          comparisonPopulation: experiment.baseline.comparisonPopulation,
          metricName: experiment.baseline.metricName,
          value: 4,
        },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { outcome: { state: string; reason?: string } };
      assert.equal(body.outcome.state, "unmeasurable");
      assert.match(body.outcome.reason ?? "", /denominator|freshness|attribution/);
      const history = (await (await get(base)).json()) as { experiments: Array<{ state: string }> };
      assert.equal(history.experiments[0]?.state, "unmeasurable");
    });
  }
});

test("unit test: a regressed self-improvement experiment records rollback without rewriting history", async () => {
  const { ledgerPath, experiment } = fixture();
  await withService(ledgerPath, async (base) => {
    await approve(base, experiment);
    const regressionResponse = await post(base, "/v1/operator-agent/experiments/outcome", {
      experimentId: experiment.experimentId,
      outcome: {
        state: "regressed",
        summary: "Queue latency increased after the intervention.",
        observedAt: NOW,
        source: "ledger:queue-latency",
        freshness: "verified",
        attribution: "complete",
        denominator: 20,
        comparisonPopulation: experiment.baseline.comparisonPopulation,
        metricName: experiment.baseline.metricName,
        value: 12,
      },
    });
    assert.equal(regressionResponse.status, 200);
    const rollbackResponse = await post(base, "/v1/operator-agent/experiments/rollback", {
      experimentId: experiment.experimentId,
      rollback: experiment.rollback,
    });
    assert.equal(rollbackResponse.status, 200);
    const history = (await (await get(base)).json()) as { experiments: Array<{ state: string; events: Array<{ kind: string; outcome?: { state: string } }> }> };
    assert.equal(history.experiments[0]?.state, "rolled_back");
    assert.deepEqual(history.experiments[0]?.events.map((event) => event.kind), ["decision", "outcome", "rollback"]);
    assert.equal(history.experiments[0]?.events[1]?.outcome?.state, "regressed");
  });
  assert.equal(readFileSync(ledgerPath, "utf8").trim().split("\n").length, 4, "registration, approval, regression, and rollback remain append-only");
});

test("unit test: self-improvement experiment history preserves version redaction and rotated evidence", async () => {
  const { ledgerPath, experiment } = fixture();
  await withService(ledgerPath, async (base) => {
    const response = await post(base, "/v1/operator-agent/experiments", { experiment: { ...experiment, hypothesis: "Use the verified queue-latency baseline." , bearerToken: "do-not-store" } });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { experiment: Record<string, unknown> };
    assert.equal(body.experiment.version, "experiment-v1");
    assert.equal("bearerToken" in body.experiment, false);
  });

  const archived = fixture("experiment:repo:rotated").experiment;
  const archive = join(join(ledgerPath, ".."), "ledger.2026-09-19T00-00-00-000Z.ndjson.gz");
  writeFileSync(archive, gzipSync(Buffer.from(`${JSON.stringify({ step: OPERATOR_AGENT_EXPERIMENT_STEP, experiment: archived })}\n`, "utf8")));
  const history = await withService(ledgerPath, async (base) => (await (await get(base)).json()) as { experiments: Array<{ experimentId: string; version: string }> });
  assert.deepEqual(history.experiments.map((item) => item.experimentId).sort(), ["experiment:repo:rotated", "experiment:repo:worker-pool"]);
  assert.ok(history.experiments.every((item) => item.version === "experiment-v1"));
});

test("unit test: self-improvement experiment routes are idempotent and refuse invalid lifecycle transitions", async () => {
  const { ledgerPath, experiment } = fixture();
  const proposedOutcome = fixture("experiment:repo:proposed-outcome").experiment;
  const proposedRollback = fixture("experiment:repo:proposed-rollback").experiment;

  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/experiments", { experiment })).status, 201);

    const duplicate = await post(base, "/v1/operator-agent/experiments", { experiment });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).existing, true);

    const conflicting = await post(base, "/v1/operator-agent/experiments", {
      experiment: { ...experiment, hypothesis: "A different hypothesis with the same experiment id." },
    });
    assert.equal(conflicting.status, 409);

    assert.equal((await post(base, "/v1/operator-agent/experiments/decision", {
      experimentId: "experiment:repo:missing",
      decision: "approved",
    })).status, 404);

    assert.equal((await post(base, "/v1/operator-agent/experiments/decision", {
      experimentId: experiment.experimentId,
      decision: "approved",
    })).status, 200);
    assert.equal((await post(base, "/v1/operator-agent/experiments/decision", {
      experimentId: experiment.experimentId,
      decision: "rejected",
    })).status, 409);

    assert.equal((await post(base, "/v1/operator-agent/experiments/outcome", {
      experimentId: "experiment:repo:missing",
      outcome: { state: "observing", summary: "No such experiment.", observedAt: NOW },
    })).status, 404);
    assert.equal((await post(base, "/v1/operator-agent/experiments", { experiment: proposedOutcome })).status, 201);
    assert.equal((await post(base, "/v1/operator-agent/experiments/outcome", {
      experimentId: proposedOutcome.experimentId,
      outcome: { state: "observing", summary: "Not approved yet.", observedAt: NOW },
    })).status, 409);

    assert.equal((await post(base, "/v1/operator-agent/experiments/rollback", {
      experimentId: "experiment:repo:missing",
      rollback: experiment.rollback,
    })).status, 404);
    assert.equal((await post(base, "/v1/operator-agent/experiments", { experiment: proposedRollback })).status, 201);
    assert.equal((await post(base, "/v1/operator-agent/experiments/rollback", {
      experimentId: proposedRollback.experimentId,
      rollback: proposedRollback.rollback,
    })).status, 409);
  });
});
