import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clockFromMillisFn, fixedClock } from "../src/lib/clock.js";
import { isPaused, isStopped, pauseFilePath, requestStop, stopFilePath } from "../src/lib/fleet-control.js";
import { buildOperatorAgentActionHandoffRoutes, type ActionHandoffConfig } from "../src/lib/operator-agent-action-handoff.js";
import { createService, type Route, type Scope } from "../src/lib/service.js";
import { buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const PREPARE = "/v1/operator-agent/action-handoff/prepare";
const EXECUTE = "/v1/operator-agent/action-handoff/execute";
const T0 = Date.parse("2026-09-30T12:00:00.000Z");

interface Harness { base: string; root: string; deps: ActionHandoffConfig; advance: (ms: number) => void }

async function listen(routes: Route[]): Promise<{ server: Server; base: string }> {
  const server = createService({
    routes, tokens: { read: "read-token", write: "write-token" }, enforceWriteTiers: true,
    operatorSession: {
      name: "test-verified-operator",
      grant: () => undefined,
      authorize: (req) => {
        const actor = req.headers["x-verified-operator"];
        return typeof actor === "string" ? { scopes: new Set<Scope>(["read", "write"]), tier: "middle", actor: `operator:${actor}` } : undefined;
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function withHandoff(action: (h: Harness) => Promise<void>, overrides: Partial<ActionHandoffConfig> = {}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}action-route-`));
  mkdirSync(join(root, "state"), { recursive: true });
  let now = T0;
  const deps: ActionHandoffConfig = { root, claimRoot: root, ledgerPath: join(root, "state", "ledger.ndjson"), instance: "core", repository: "owner/repo", clock: clockFromMillisFn(() => now), ...overrides };
  const { server, base } = await listen(buildOperatorAgentActionHandoffRoutes(deps));
  try {
    await action({ base, root, deps, advance: (ms) => { now += ms; } });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

function post(base: string, path: string, body: unknown, operator: string | null = "alice"): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer write-token", "content-type": "application/json", ...(operator ? { "x-verified-operator": operator } : {}) },
    body: JSON.stringify(body),
  });
}

const intent = (intentId: string, extra: Record<string, unknown> = {}) => ({ intentId, verb: "fleet.pause", instance: "core", repository: "owner/repo", ...extra });

async function prepare(base: string, intentId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await post(base, PREPARE, intent(intentId, extra));
  assert.equal(response.status, 201, `prepare ${intentId}`);
  return ((await response.json()) as { confirmationId: string }).confirmationId;
}

const confirmed = (confirmationId: string, extra: Record<string, unknown> = {}) =>
  ({ confirmationId, confirm: true, verb: "fleet.pause", instance: "core", repository: "owner/repo", ...extra });

function ledgerSteps(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => String((JSON.parse(line) as { step: unknown }).step)) : [];
}

/** Every fleet-control artifact under the target root; the handoff's own claim store is not a target. */
function targetFiles(root: string): string[] {
  return readdirSync(join(root, "state")).filter((name) => name !== "assistant-action-handoffs" && name !== "ledger.ndjson").sort();
}

test("execution requires explicit confirmation and revalidates target, scope, freshness, tier, and consequence before a governed verb runs", async () => {
  await withHandoff(async ({ base, root, deps, advance }) => {
    const id = await prepare(base, "intent-route-confirm-01");
    for (const body of [{ ...confirmed(id), confirm: undefined }, confirmed(id, { confirm: "yes" }), confirmed(id, { confirm: false })]) {
      const response = await post(base, EXECUTE, body);
      assert.equal(response.status, 400, "no explicit boolean confirmation, no execution");
    }
    assert.equal((await post(base, EXECUTE, confirmed(id), null)).status, 403, "a low-tier bearer write grant cannot reach the middle-tier execute route");
    const other = await post(base, EXECUTE, confirmed(id), "mallory");
    assert.equal(other.status, 403);
    assert.equal(((await other.json()) as { code: string }).code, "actor_mismatch", "a confirmation is bound to the operator who prepared it");
    assert.equal(isPaused(root), false);

    const stale = await prepare(base, "intent-route-stale-01");
    advance(11 * 60_000);
    const staleResponse = await post(base, EXECUTE, confirmed(stale));
    assert.equal(staleResponse.status, 409);
    assert.equal(((await staleResponse.json()) as { code: string }).code, "stale_preview");
    const fresh = await prepare(base, "intent-route-confirm-02");

    const edited = await prepare(base, "intent-route-edited-01");
    const editedResponse = await post(base, EXECUTE, confirmed(edited, { verb: "fleet.resume" }));
    assert.equal(((await editedResponse.json()) as { code: string }).code, "target_changed", "the confirmed verb must equal the previewed verb");

    const scoped = await prepare(base, "intent-route-scope-01");
    const rescoped = await listen(buildOperatorAgentActionHandoffRoutes({ ...deps, repository: "owner/other" }));
    try {
      const response = await post(rescoped.base, EXECUTE, confirmed(scoped));
      assert.equal(response.status, 409);
      assert.equal(((await response.json()) as { code: string }).code, "scope_changed", "the serving repository must still own the target");
    } finally {
      await new Promise<void>((resolve) => rescoped.server.close(() => resolve()));
    }

    const drifted = await prepare(base, "intent-route-drift-01");
    requestStop(root, "operator hard stop");
    const driftResponse = await post(base, EXECUTE, confirmed(drifted));
    assert.equal(((await driftResponse.json()) as { code: string }).code, "target_changed", "target state changed since the preview");
    const resumeUnderStop = await post(base, PREPARE, intent("intent-route-policy-01", { verb: "fleet.resume" }));
    assert.equal(resumeUnderStop.status, 409);
    assert.equal(((await resumeUnderStop.json()) as { code: string }).code, "policy_refused", "the catalogue consequence policy refuses lifting a STOP");
    assert.equal(isPaused(root), false);
    assert.equal(ledgerSteps(deps.ledgerPath).filter((step) => step.startsWith("panel.")).length, 0, "no governed verb ran on any refusal");
    rmSync(stopFilePath(root), { force: true });
    assert.equal(isStopped(root), false);

    const ok = await post(base, EXECUTE, confirmed(fresh));
    assert.equal(ok.status, 200);
    const receipt = (await ok.json()) as { outcome: string; verb: string; repository: string; instance: string };
    assert.deepEqual([receipt.outcome, receipt.verb, receipt.repository, receipt.instance], ["succeeded", "fleet.pause", "owner/repo", "core"]);
    assert.ok(isPaused(root), "the governed pause verb ran");
    assert.equal(ledgerSteps(deps.ledgerPath).filter((step) => step === "panel.pause_requested").length, 1);
  });
});

test("unsafe assistant actions refuse without a target write", async () => {
  await withHandoff(async ({ base, root, deps }) => {
    const before = targetFiles(root);
    const prepares: Array<[string, Record<string, unknown>, string]> = [
      ["unknown verb", intent("intent-unsafe-01", { verb: "shell.exec" }), "unknown_verb"],
      ["arbitrary api path", intent("intent-unsafe-02", { verb: "/v1/control/stop" }), "unknown_verb"],
      ["high-risk verb", intent("intent-unsafe-03", { verb: "task.kick" }), "excluded_in_v1"],
      ["irreversible verb", intent("intent-unsafe-04", { verb: "pr.review" }), "excluded_in_v1"],
      ["cross-repository", intent("intent-unsafe-05", { repository: "owner/other" }), "cross_repository"],
      ["cross-instance", intent("intent-unsafe-06", { instance: "site" }), "cross_instance"],
      ["model-supplied bearer token", intent("intent-unsafe-07", { authorization: "Bearer abcdefghijklmnop" }), "model_supplied_authority"],
      ["model-supplied credential value", intent("Bearer abcdefghijklmnop"), "model_supplied_authority"],
      ["answer-v1 payload", { version: "answer-v1", answer: "Pause the fleet now.", citations: [], ...intent("intent-unsafe-08") }, "answer_not_authority"],
      ["approval smuggled in", intent("intent-unsafe-09", { approval: { decision: "approved" } }), "unknown_field"],
    ];
    for (const [label, body, code] of prepares) {
      const response = await post(base, PREPARE, body);
      assert.ok(response.status >= 400, label);
      const refusal = (await response.json()) as { outcome: string; code: string };
      assert.deepEqual([refusal.outcome, refusal.code], ["refused", code], label);
    }
    const executes: Array<[string, Record<string, unknown>, string]> = [
      ["forged confirmation", confirmed("00000000-0000-4000-8000-000000000000"), "unknown_handoff"],
      ["answer-v1 as confirmation", { version: "answer-v1", answer: "Confirmed.", confirm: true, confirmationId: "00000000-0000-4000-8000-000000000000" }, "answer_not_authority"],
      ["model-supplied token", confirmed("00000000-0000-4000-8000-000000000000", { token: "sk-abcdefghijk" }), "model_supplied_authority"],
    ];
    for (const [label, body, code] of executes) {
      const response = await post(base, EXECUTE, body);
      assert.ok(response.status >= 400, label);
      assert.equal(((await response.json()) as { code: string }).code, code, label);
    }
    const stale = await prepare(base, "intent-unsafe-stale");
    const staleDeps = { ...deps, clock: fixedClock(T0 + 60 * 60_000) };
    const later = await listen(buildOperatorAgentActionHandoffRoutes(staleDeps));
    try {
      assert.equal(((await (await post(later.base, EXECUTE, confirmed(stale))).json()) as { code: string }).code, "stale_preview");
    } finally {
      await new Promise<void>((resolve) => later.server.close(() => resolve()));
    }
    assert.deepEqual(targetFiles(root), before, "no refused action wrote a fleet-control target");
    assert.equal(ledgerSteps(deps.ledgerPath).filter((step) => step.startsWith("panel.")).length, 0);

    const once = await prepare(base, "intent-unsafe-replay");
    assert.equal((await post(base, EXECUTE, confirmed(once))).status, 200);
    const pausedAt = statSync(pauseFilePath(root)).mtimeMs;
    const replay = await post(base, EXECUTE, confirmed(once));
    assert.equal(replay.status, 409);
    assert.equal(((await replay.json()) as { code: string }).code, "replayed");
    assert.equal(statSync(pauseFilePath(root)).mtimeMs, pausedAt, "a replayed confirmation writes no target");
    assert.equal(ledgerSteps(deps.ledgerPath).filter((step) => step === "panel.pause_requested").length, 1);
  });
});

test("the served assembly mounts action-handoff-v1 separately from read-only answer-v1", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}action-route-served-`));
  try {
    mkdirSync(join(root, "plan"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    const planPath = join(root, "plan", "tasks.yaml");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    writeFileSync(planPath, "[]\n");
    const deps: ServeDeps = {
      board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github: fakeGitHub() },
      panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} } },
      ledgerPath, issues: { close: () => {} }, fleetControlRoot: root, questionsRoot: root,
      tokens: { read: "read-token", write: "write-token" }, assistantRepository: "owner/repo",
    };
    const assembled = buildServeRoutes(deps);
    const find = (path: string) => assembled.find((route) => route.method === "POST" && route.path === path);
    const [prep, exec, ask] = [find(PREPARE), find(EXECUTE), find("/v1/operator-agent/ask")];
    assert.ok(prep && exec && ask, "prepare, execute, and the answer route are all mounted");
    assert.deepEqual([prep.scope, prep.tier], ["write", "low"]);
    assert.deepEqual([exec.scope, exec.tier], ["write", "middle"]);
    assert.equal(ask.scope, "read", "answer-v1 stays read-only");
    const { server, base } = await listen([prep, exec, ask]);
    try {
      const answer = (await (await post(base, "/v1/operator-agent/ask", { question: "Should I pause the fleet?" })).json()) as Record<string, unknown>;
      assert.equal(answer.version, "answer-v1");
      const refused = await post(base, EXECUTE, { ...answer, confirm: true });
      assert.equal(refused.status, 400, "an answer-v1 payload is never a confirmation");
      const id = await prepare(base, "intent-served-01");
      assert.equal((await post(base, EXECUTE, confirmed(id))).status, 200);
      assert.ok(isPaused(root), "the served execute route targets the fleet-control root");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
