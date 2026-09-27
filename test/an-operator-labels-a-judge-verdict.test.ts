/**
 * W1-T4634 — a judge-calibration sample nobody can label corrects nothing. POST /v1/judge-labels is
 * the write path: it stores an operator's pass/fail label, stamped server-side with the labeller and
 * the credential's hashed origin, and the next judge-calibration-v1 derivation counts it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  buildRecordJudgeLabelRoute,
  deriveJudgeCalibration,
  fileJudgeLabelStore,
  JUDGE_LABEL_RECORDED_STEP,
  JUDGE_LABELS_FILENAME,
  loadJudgeLabels,
  type JudgeLabel,
  type JudgeLabelStore,
} from "../src/lib/judge-calibration.js";
import { hashToken } from "../src/lib/last-seen.js";
import type { Plan } from "../src/lib/plan.js";
import { buildServeRoutes, buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { createService, type Route } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const READ_TOKEN = "judge-label-read-token";
const WRITE_TOKEN = "judge-label-write-token";
const CLOCK_MS = Date.parse("2026-09-27T12:34:56.000Z");
const OUT_OF_SAMPLE_REF = "jv-0123456789abcdef";
type Row = Record<string, unknown>;

/** Two authored heads, each reviewed once by judge-1: two sampled verdicts. */
function judgedHeadRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 2; i += 1) {
    const head = `h${i}${"0".repeat(39)}`;
    const at = (s: number) => new Date(Date.parse("2026-09-20T00:00:00.000Z") + i * 60_000 + s * 1000).toISOString();
    rows.push(
      { ts: at(0), step: "worker.assignment", run_id: `run-${i}`, worker_assignment: { id: `asg-${i}`, selected: { model: "author-a" } } },
      { ts: at(1), step: "implement.done", run_id: `run-${i}`, head_sha: head, head_assignment: `asg-${i}` },
      {
        ts: at(2), step: "review.posted", run_id: `run-${i}`, head_sha: head, state: i === 0 ? "success" : "failure",
        reviewer_outcome: "success", evaluator_provenance: { servedModel: "judge-1" },
      },
    );
  }
  return rows;
}

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-labels-`));
  writeFileSync(join(dir, "ledger.ndjson"), "");
  return dir;
}

function appendedRows(path: string): Row[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function withRoute<T>(route: Route, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: [route] });
  const base = await listen(server);
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

function post(base: string, body: unknown, token = WRITE_TOKEN): Promise<Response> {
  return fetch(`${base}/v1/judge-labels`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST /v1/judge-labels stores a server-stamped label with its labeller and ledgers the credential's hashed origin; the next derivation counts it", async () => {
  const dir = stateDir();
  const ledgerPath = join(dir, "ledger.ndjson");
  const rows = judgedHeadRows();
  const before = deriveJudgeCalibration(rows, { asOf: null, labels: loadJudgeLabels(fileJudgeLabelStore(dir)) });
  assert.equal(before.sample.length, 2, "positive control: the fixture draws a two-verdict queue");
  assert.equal(before.labels.matched, 0);
  const target = before.sample[0]!.verdictRef;

  const route = buildRecordJudgeLabelRoute(fileJudgeLabelStore(dir), ledgerPath, () => before.sample, fixedClock(CLOCK_MS));
  await withRoute(route, async (base) => {
    const res = await post(base, { verdictRef: target, label: "fail", labeller: "  craig  ", labelledAt: "1999-01-01T00:00:00.000Z" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      verdictRef: target,
      label: "fail",
      labeller: "craig",
      labelledAt: "2026-09-27T12:34:56.000Z",
      sampleMembership: "in-sample",
    });
  });

  const stored = fileJudgeLabelStore(dir).read();
  assert.deepEqual(stored, [{ verdictRef: target, label: "fail", labeller: "craig", labelledAt: "2026-09-27T12:34:56.000Z" }], "the body's labelledAt is never trusted");
  const recorded = appendedRows(ledgerPath).filter((row) => row.step === JUDGE_LABEL_RECORDED_STEP);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.origin, hashToken(WRITE_TOKEN), "origin is the bearer's hashed identity, never the raw token");
  assert.equal(recorded[0]!.task_id, target);
  assert.equal(recorded[0]!.labeller, "craig");
  assert.equal(recorded[0]!.sample_membership, "in-sample");

  const after = deriveJudgeCalibration(rows, { asOf: null, labels: loadJudgeLabels(fileJudgeLabelStore(dir)) });
  assert.equal(after.labels.count, 1);
  assert.equal(after.labels.matched, 1);
  assert.equal(after.sample.find((item) => item.verdictRef === target)!.labelled, true);
  assert.equal(after.strata[0]!.labelled, 1);
});

test("invalid input is a 400 and writes nothing", async () => {
  const dir = stateDir();
  const ledgerPath = join(dir, "ledger.ndjson");
  const route = buildRecordJudgeLabelRoute(fileJudgeLabelStore(dir), ledgerPath, () => [], fixedClock(CLOCK_MS));
  const good = { verdictRef: OUT_OF_SAMPLE_REF, label: "pass", labeller: "craig" };
  const bodies: unknown[] = [
    "{not json",
    [good],
    { ...good, verdictRef: "W1-T4634" },
    { ...good, verdictRef: 7 },
    { ...good, label: "maybe" },
    { ...good, labeller: "   " },
    { ...good, labeller: undefined },
  ];
  await withRoute(route, async (base) => {
    for (const body of bodies) {
      const res = await post(base, body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal(((await res.json()) as { error: string }).error, "invalid_request");
    }
    const forbidden = await post(base, good, READ_TOKEN);
    assert.equal(forbidden.status, 403, "the read token cannot label");
  });
  assert.equal(existsSync(join(dir, JUDGE_LABELS_FILENAME)), false);
  assert.deepEqual(appendedRows(ledgerPath), []);
});

test("a verdict outside the current sample is stored but flagged, and an undrawn sample reads unavailable", async () => {
  const dir = stateDir();
  const ledgerPath = join(dir, "ledger.ndjson");
  const sample = deriveJudgeCalibration(judgedHeadRows(), { asOf: null, labels: { labels: [] } }).sample;
  assert.ok(sample.length > 0 && !sample.some((item) => item.verdictRef === OUT_OF_SAMPLE_REF));
  let current: typeof sample | undefined = sample;
  const route = buildRecordJudgeLabelRoute(fileJudgeLabelStore(dir), ledgerPath, () => current, fixedClock(CLOCK_MS));
  await withRoute(route, async (base) => {
    const out = await post(base, { verdictRef: OUT_OF_SAMPLE_REF, label: "pass", labeller: "craig" });
    assert.equal(out.status, 200);
    assert.equal(((await out.json()) as { sampleMembership: string }).sampleMembership, "out-of-sample");
    current = undefined;
    const cold = await post(base, { verdictRef: OUT_OF_SAMPLE_REF, label: "fail", labeller: "craig" });
    assert.equal(((await cold.json()) as { sampleMembership: string }).sampleMembership, "sample-unavailable");
  });
  assert.deepEqual(fileJudgeLabelStore(dir).read().map((label) => label.label), ["pass", "fail"]);
  assert.deepEqual(appendedRows(ledgerPath).map((row) => row.sample_membership), ["out-of-sample", "sample-unavailable"]);
});

test("a store that cannot be written is a 500 write_failed and ledgers nothing", async () => {
  const dir = stateDir();
  const ledgerPath = join(dir, "ledger.ndjson");
  const broken: JudgeLabelStore = {
    read: (): JudgeLabel[] => [],
    write: () => {
      throw new Error("disk full");
    },
  };
  await withRoute(buildRecordJudgeLabelRoute(broken, ledgerPath, () => [], fixedClock(CLOCK_MS)), async (base) => {
    const res = await post(base, { verdictRef: OUT_OF_SAMPLE_REF, label: "pass", labeller: "craig" });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "write_failed" });
  });
  assert.deepEqual(appendedRows(ledgerPath), []);
});

function serveDeps(dir: string): ServeDeps {
  const ledgerPath = join(dir, "ledger.ndjson");
  const repoRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-labels-repo-`));
  mkdirSync(join(repoRoot, "plan"), { recursive: true });
  const planPath = join(repoRoot, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const plan: Plan = { tasks: [], byId: new Map() };
  return {
    board: { plan, ledgerPath, github: fakeGitHub() },
    panelGraph: {
      root: repoRoot,
      planPath,
      ledgerPath,
      github: { prView: () => null },
      statusGithub: fakeGitHub(),
      ratify: { approve: () => {}, reframe: () => {} },
    },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-labels-fleet-`)),
    questionsRoot: repoRoot,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
    log: () => {},
  };
}

test("the served route table carries POST /v1/judge-labels, write-scoped at LOW, writing the state dir analytics reads", async () => {
  const dir = stateDir();
  const deps = serveDeps(dir);
  const route = buildServeRoutes(deps).find((r) => r.path === "/v1/judge-labels");
  assert.ok(route, "POST /v1/judge-labels is in the assembled route table");
  assert.equal(route.method, "POST");
  assert.equal(route.scope, "write");
  assert.equal(route.tier, "low");

  const server = buildServeServer(deps);
  const base = await listen(server);
  try {
    const res = await post(base, { verdictRef: OUT_OF_SAMPLE_REF, label: "pass", labeller: "craig" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { labelledAt: string; sampleMembership: string };
    // An empty ledger draws an empty queue once the cache refreshes; before that, no queue at all.
    assert.ok(["out-of-sample", "sample-unavailable"].includes(body.sampleMembership), body.sampleMembership);
    assert.ok(!Number.isNaN(Date.parse(body.labelledAt)));
  } finally {
    server.close();
  }
  assert.deepEqual(fileJudgeLabelStore(dir).read().map((label) => label.verdictRef), [OUT_OF_SAMPLE_REF], "the label lands in dirname(ledgerPath), the store analytics reads");
  assert.equal(appendedRows(deps.ledgerPath).filter((row) => row.step === JUDGE_LABEL_RECORDED_STEP).length, 1);
});
