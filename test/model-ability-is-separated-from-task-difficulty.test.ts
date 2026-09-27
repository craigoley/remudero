/**
 * W1-T4626 — raw pass rates mix a model's ability with the difficulty of the tasks the router
 * happened to hand it. The ability map fits P(success) = sigmoid(theta_model + theta_role - beta_task)
 * and reports ability apart from difficulty, with intervals, leaving thin cells blank.
 */
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { test } from "node:test";

import {
  ABILITY_MAP_VERSION,
  abilityObservation,
  fitAbilityMap,
  type AbilityCell,
  type AbilityObservation,
} from "../src/lib/ability-map.js";
import { buildAnalyticsRoute, deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function estimated(cells: readonly AbilityCell[], key: string): Extract<AbilityCell, { state: "estimated" }> {
  const cell = cells.find((c) => c.key === key);
  assert.ok(cell, `cell ${key} is reported`);
  assert.equal(cell.state, "estimated", `cell ${key} has enough evidence to estimate`);
  return cell as Extract<AbilityCell, { state: "estimated" }>;
}

function simulate(seed: number) {
  const rand = mulberry32(seed);
  const theta: Record<string, number> = { "m-a": -1.0, "m-b": -0.3, "m-c": 0.4, "m-d": 1.2 };
  const rho: Record<string, number> = { implement: 0.4, review: -0.4 };
  const beta: Record<string, number> = {};
  for (let t = 0; t < 40; t += 1) beta[`T${t}`] = -2 + (4 * t) / 39;
  const observations: AbilityObservation[] = [];
  for (const [model, th] of Object.entries(theta)) {
    for (const [role, rh] of Object.entries(rho)) {
      for (const [task, b] of Object.entries(beta)) {
        for (let k = 0; k < 2; k += 1) {
          observations.push(abilityObservation({ model, role, task, recordedSuccess: rand() < sigmoid(th + rh - b) }));
        }
      }
    }
  }
  const betaMean = mean(Object.values(beta));
  const rhoMean = mean(Object.values(rho));
  return {
    observations,
    truth: {
      models: Object.fromEntries(Object.entries(theta).map(([k, v]) => [k, v + rhoMean - betaMean])),
      roles: Object.fromEntries(Object.entries(rho).map(([k, v]) => [k, v - rhoMean])),
      tasks: Object.fromEntries(Object.entries(beta).map(([k, v]) => [k, v - betaMean])),
    },
  };
}

test("synthetic ground truth: the fit recovers model ordering, role effects and task difficulty with covering intervals", () => {
  let covered = 0;
  let total = 0;
  for (const seed of [11, 23, 37]) {
    const { observations, truth } = simulate(seed);
    const map = fitAbilityMap(observations);
    assert.equal(map.version, ABILITY_MAP_VERSION);
    assert.equal(map.state, "fitted");
    assert.equal(map.fit.converged, true);
    const order = ["m-a", "m-b", "m-c", "m-d"].map((m) => estimated(map.models, m).estimate);
    for (let i = 1; i < order.length; i += 1) assert.ok(order[i]! > order[i - 1]!, `seed ${seed}: model ordering recovered (${order.join(", ")})`);
    assert.ok(estimated(map.roles, "implement").estimate > estimated(map.roles, "review").estimate, "role effect recovered");
    const taskEstimates = Object.keys(truth.tasks).map((t) => estimated(map.tasks, t).estimate);
    const truthTasks = Object.values(truth.tasks);
    const covariance = mean(taskEstimates.map((e, i) => (e - mean(taskEstimates)) * (truthTasks[i]! - mean(truthTasks))));
    const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
    assert.ok(covariance / (sd(taskEstimates) * sd(truthTasks)) > 0.8, "task difficulty tracks the truth");
    for (const [family, cells] of [["models", map.models], ["roles", map.roles], ["tasks", map.tasks]] as const) {
      for (const [key, value] of Object.entries(truth[family])) {
        const cell = estimated(cells, key);
        assert.ok(cell.standardError > 0 && Number.isFinite(cell.standardError), `${key} carries a finite interval`);
        assert.ok(cell.interval.lower < cell.estimate && cell.estimate < cell.interval.upper);
        total += 1;
        if (cell.interval.lower <= value && value <= cell.interval.upper) covered += 1;
      }
    }
  }
  assert.ok(covered / total >= 0.85, `95% intervals cover the truth at a nominal-ish rate (${covered}/${total})`);
});

test("the fit is deterministic: identical input gives identical output", () => {
  const { observations } = simulate(5);
  assert.deepEqual(fitAbilityMap(observations), fitAbilityMap([...observations].reverse()));
});

test("thin cells are reported as insufficient, never as a number or a zero", () => {
  const { observations } = simulate(7);
  const thin: AbilityObservation[] = [
    abilityObservation({ model: "m-rare", role: "implement", task: "T0", recordedSuccess: false }),
    abilityObservation({ model: "m-rare", role: "implement", task: "T-once", recordedSuccess: true }),
    abilityObservation({ model: "m-a", role: "triage", task: "T1", recordedSuccess: true }),
  ];
  const map = fitAbilityMap([...observations, ...thin]);
  for (const [cells, key] of [[map.models, "m-rare"], [map.roles, "triage"], [map.tasks, "T-once"]] as const) {
    const cell = cells.find((c) => c.key === key);
    assert.ok(cell, `${key} is listed rather than silently dropped`);
    assert.equal(cell.state, "insufficient");
    assert.equal("estimate" in cell, false, `${key} carries no estimate at all`);
    assert.equal("interval" in cell, false);
    assert.ok(cell.attempts < cell.minimumAttempts);
  }
  assert.equal(estimated(map.models, "m-a").state, "estimated");

  const empty = fitAbilityMap([]);
  assert.equal(empty.state, "unavailable");
  assert.equal(empty.reason, "no-observations");
  assert.deepEqual(empty.models, []);
});

test("confounding: raw pass rates rank the weaker model first, the fit separates ability from assigned difficulty", () => {
  const rand = mulberry32(99);
  const observations: AbilityObservation[] = [];
  const attempt = (model: string, task: string, p: number) =>
    observations.push(abilityObservation({ model, role: "implement", task, recordedSuccess: rand() < p }));
  // The router hands the strong model the hard tasks and the weak model the easy ones.
  for (let t = 0; t < 20; t += 1) for (let k = 0; k < 6; k += 1) attempt("strong", `hard-${t}`, sigmoid(1 - 2));
  for (let t = 0; t < 20; t += 1) for (let k = 0; k < 6; k += 1) attempt("weak", `easy-${t}`, sigmoid(-1 + 2));
  // A shared bridge of medium tasks links the two populations.
  for (let t = 0; t < 12; t += 1) {
    for (let k = 0; k < 6; k += 1) {
      attempt("strong", `mid-${t}`, sigmoid(1));
      attempt("weak", `mid-${t}`, sigmoid(-1));
    }
  }
  const map = fitAbilityMap(observations);
  const strong = estimated(map.models, "strong");
  const weak = estimated(map.models, "weak");
  assert.ok(weak.successes / weak.attempts > strong.successes / strong.attempts,
    `raw pass rate misleads: weak ${weak.successes}/${weak.attempts} beats strong ${strong.successes}/${strong.attempts}`);
  assert.ok(strong.interval.lower > weak.interval.upper, "the fit separates the strong model above the weak one");
  const hard = mean(Array.from({ length: 20 }, (_, t) => estimated(map.tasks, `hard-${t}`).estimate));
  const easy = mean(Array.from({ length: 20 }, (_, t) => estimated(map.tasks, `easy-${t}`).estimate));
  assert.ok(hard - easy > 2, `assigned difficulty is attributed to the tasks (hard ${hard.toFixed(2)} vs easy ${easy.toFixed(2)})`);
});

test("outcome source is labelled: verified when supplied, else attempt-recorded", () => {
  const verified = abilityObservation({ model: "m", role: "implement", task: "T", recordedSuccess: true, verifiedSuccess: false });
  assert.deepEqual(verified, { model: "m", role: "implement", task: "T", success: false, source: "verified" });
  const recorded = abilityObservation({ model: "m", role: "implement", task: "T", recordedSuccess: true });
  assert.equal(recorded.source, "attempt-recorded");
  const map = fitAbilityMap([verified, recorded]);
  assert.deepEqual(map.outcomeSources, { verified: 1, "attempt-recorded": 1 });
  assert.equal(map.evidence, "observational");
  assert.equal(map.publicRanking, false);
});

const NOW = "2026-09-27T12:00:00.000Z";

function ledgerLines(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  let n = 0;
  const run = (taskId: string, model: string, success: boolean) => {
    n += 1;
    const runId = `R${n}`;
    const id = `assignment-${n}`;
    lines.push({ ts: "2026-09-27T10:00:00.000Z", step: "run.start", run_id: runId, task_id: taskId, type: "implement" });
    lines.push({
      ts: "2026-09-27T10:00:01.000Z", step: "worker.assignment", run_id: runId, task_id: taskId,
      worker_assignment: {
        version: 1, id, phase: "pre-execution",
        requested: { model: "sonnet", effort: "high", maxTurns: 400 },
        selected: { provider: "claude", model, effort: "high" },
        routing: { mode: "claude-only", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
        candidates: [],
      },
    });
    lines.push({ ts: "2026-09-27T10:30:00.000Z", step: "verdict", run_id: runId, task_id: taskId, verdict: success ? "merged" : "blocked", success, selection_assignment_id: id });
  };
  for (let t = 0; t < 4; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      run(`W1-T${t}`, "model-x", (t + k) % 2 === 0);
      run(`W1-T${t}`, "model-y", k === 0);
    }
  }
  // An assignment with no terminal outcome and a lane pseudo-task are counted, never fitted.
  lines.push({ ts: "2026-09-27T11:00:00.000Z", step: "worker.assignment", run_id: "inbox-draft-z", task_id: "INBOX-DRAFT", lane: "inbox-draft",
    worker_assignment: { version: 1, id: "assignment-z", phase: "pre-execution", requested: { model: "sonnet", effort: "high", maxTurns: 1 },
      selected: { provider: "claude", model: "model-x", effort: "high" }, routing: { mode: "claude-only" }, candidates: [] } });
  lines.push({ ts: "2026-09-27T11:00:00.000Z", step: "worker.assignment", run_id: "R-open", task_id: "W1-T9",
    worker_assignment: { version: 1, id: "assignment-open", phase: "pre-execution", requested: { model: "sonnet", effort: "high", maxTurns: 1 },
      selected: { provider: "claude", model: "model-y", effort: "high" }, routing: { mode: "claude-only" }, candidates: [] } });
  return lines;
}

function fakeResponse() {
  let body = "";
  let status = 0;
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { body = chunk ?? ""; },
  } as unknown as ServerResponse;
  return { res, body: () => body, status: () => status || (res as unknown as { statusCode: number }).statusCode };
}

test("the analytics route serves the ability map as a private, versioned, observational projection", async () => {
  const base = deriveAnalyticsSnapshot(ledgerLines(), NOW);
  const route = buildAnalyticsRoute({ currentSnapshot: () => base });

  const versioned = fakeResponse();
  await route.handler({ url: `/v1/analytics?projectionVersion=${ABILITY_MAP_VERSION}` } as never, versioned.res, { params: {} });
  const map = JSON.parse(versioned.body()) as ReturnType<typeof fitAbilityMap>;
  assert.equal(map.version, ABILITY_MAP_VERSION);
  assert.equal(map.state, "fitted");
  assert.equal(map.evidence, "observational");
  assert.equal(map.publicRanking, false);
  assert.equal(map.observations, 24, "every assignment joined to a terminal verdict by selection_assignment_id is one observation");
  assert.deepEqual(map.outcomeSources, { verified: 0, "attempt-recorded": 24 });
  assert.deepEqual(map.excluded, { withoutTask: 1, withoutOutcome: 1 });
  assert.deepEqual(map.models.map((c) => c.key), ["model-x", "model-y"]);
  assert.deepEqual(map.roles.map((c) => c.key), ["implement"], "role comes from the run's own phase");
  assert.deepEqual(map.tasks.map((c) => c.key), ["W1-T0", "W1-T1", "W1-T2", "W1-T3"]);

  const full = fakeResponse();
  await route.handler({ url: "/v1/analytics" } as never, full.res, { params: {} });
  assert.equal("abilityMap" in (JSON.parse(full.body()) as Record<string, unknown>), false, "private by default: never in the unversioned body");

  const cold = buildAnalyticsRoute({ currentSnapshot: () => ({ ...base, abilityMap: undefined }) });
  const pending = fakeResponse();
  await cold.handler({ url: `/v1/analytics?projectionVersion=${ABILITY_MAP_VERSION}` } as never, pending.res, { params: {} });
  const unavailable = JSON.parse(pending.body()) as ReturnType<typeof fitAbilityMap>;
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.reason, "ability-map-refresh-pending");
});
