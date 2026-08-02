/**
 * test/skill-run-route-registered.test.ts — impl-EQ.
 *
 * THE WRITE HALF of the defect W1-T284 fixed for the read half. `buildPanelSkillRunRoutes`
 * (lib/panel-skill-run.ts, W3-T8 round 3) had no caller anywhere in src/, so POST /v1/skills/run
 * 404'd on every running console while twelve tests in test/panel-skill-run.test.ts exercised it
 * happily by calling the handler DIRECTLY.
 *
 * THAT DIRECTNESS IS THE POINT. A handler-level test passes identically whether or not the route
 * is registered, so it cannot catch this class at all — it is the exact shape of the original
 * defect. Every assertion below therefore goes through `buildServeRoutes` / `buildServeServer`,
 * the SAME assembler `rmd serve` itself calls, and the live cases speak HTTP to an
 * ephemeral-port server. The module's own request-handling logic stays
 * test/panel-skill-run.test.ts's job — the same split test/skills-panel-registered.test.ts draws.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { Plan } from "../src/lib/plan.js";
import { buildServeRoutes, buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { skillsDir } from "../src/lib/skill.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";

const READ_TOKEN = "skill-run-registered-read-token";
const WRITE_TOKEN = "skill-run-registered-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-skill-run-registered-"));
}

/** A registry entry in TODAY's format — the six fields lib/skill.ts requires. */
function writeSkillYaml(root: string, name: string, groundingSource = "plan/tasks.yaml"): void {
  const dir = skillsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.yaml`),
    [
      `tools:\n  - Read`,
      `permission_profile: implement`,
      `output_contract: a PR`,
      `grounding_sources:\n  - ${groundingSource}`,
      `gate: ci + remudero-review`,
      `tier: G-17`,
      "",
    ].join("\n"),
  );
}

/** One real plan task, so Refine has something to target. */
function writePlan(root: string, withTask: boolean): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(
    planPath,
    withTask
      ? [
          "- id: W1-T900",
          '  title: "a task Refine can target"',
          "  repo: remudero",
          "  depends_on: []",
          "  type: implement",
          "  verify: auto",
          "",
        ].join("\n")
      : "[]\n",
  );
  return planPath;
}

function ledgerPathFor(root: string): string {
  mkdirSync(join(root, "state"), { recursive: true });
  const p = join(root, "state", "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

const fakeGitHub = (): GitHub => ({
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
});
const fakeTraceGithub = (): TraceGithub => ({ prView: () => null });
const fakeIssueCloser = (): IssueCloser => ({ close: () => {} });
const fakeRatifyGateway = (): RatifyCliGateway => ({ approve: () => {}, reframe: () => {} });
const planOf = (): Plan => ({ tasks: [], byId: new Map() });

function depsFor(root: string, withTask = true): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root, withTask);
  return {
    board: { plan: planOf(), ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: fakeGitHub(), ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
  };
}

async function withServeServer<T>(deps: ServeDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, body: unknown, token?: string) {
  return fetch(`${base}/v1/skills/run`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

// ── (1) registered on the real route table, write-scoped ────────────────────

test("buildServeRoutes registers POST /v1/skills/run, write-scoped", () => {
  const routes = buildServeRoutes(depsFor(tmpRoot()));
  const route = routes.find((r) => r.method === "POST" && r.path === "/v1/skills/run");
  assert.ok(route, "expected POST /v1/skills/run in buildServeRoutes' output");
  assert.equal(route!.scope, "write", "executing a skill is a write, never a read");
});

// ── (2) the live server answers it, and the wired skill actually runs ───────

test("POST /v1/skills/run on the live assembled server runs Refine, not a 404", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  await withServeServer(depsFor(root), async (base) => {
    const res = await post(base, { skill: "plan", mode: "clarify", taskId: "W1-T900" }, WRITE_TOKEN);
    assert.notEqual(res.status, 404, "the route must be mounted");
    const raw = await res.text(); // read ONCE — a .text() in an assert message consumes it
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${raw}`);
    const body = JSON.parse(raw) as { ok: boolean; skill: string; feedback: { id: string; status: string } };
    assert.equal(body.ok, true);
    assert.equal(body.skill, "plan");
    assert.equal(body.feedback.status, "grilling", "Refine's product is a grilling feedback entry");
  });
});

test("the invocation is ledgered as panel.skill_invoked", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  const deps = depsFor(root);
  await withServeServer(deps, async (base) => {
    const res = await post(base, { skill: "plan", mode: "clarify", taskId: "W1-T900" }, WRITE_TOKEN);
    assert.equal(res.status, 200);
  });
  const lines = readFileSync(deps.ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const row = lines.find((l) => l.step === "panel.skill_invoked");
  assert.ok(row, `expected a panel.skill_invoked row, got ${JSON.stringify(lines.map((l) => l.step))}`);
  assert.equal(row!.grilling, true);
});

// ── (3) the write token is genuinely required ───────────────────────────────

test("POST /v1/skills/run refuses a read token and refuses anonymous", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  await withServeServer(depsFor(root), async (base) => {
    const anon = await post(base, { skill: "plan", mode: "clarify", taskId: "W1-T900" });
    assert.equal(anon.status, 401, "anonymous must not execute a skill");

    const readOnly = await post(base, { skill: "plan", mode: "clarify", taskId: "W1-T900" }, READ_TOKEN);
    assert.ok(readOnly.status === 401 || readOnly.status === 403, `a read token must not execute a skill, got ${readOnly.status}`);
  });
});

// ── (4) the narrowness is real: nothing else can be invoked ─────────────────

test("an unwired skill is refused with a 400 that names what is unwired, never a spawn", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  writeSkillYaml(root, "retro");
  await withServeServer(depsFor(root), async (base) => {
    const res = await post(base, { skill: "retro", mode: "clarify", taskId: "W1-T900" }, WRITE_TOKEN);
    assert.equal(res.status, 400, "only plan+clarify is wired");
    const body = (await res.json()) as { detail: string };
    assert.match(body.detail, /no run implementation yet/);
  });
});

test("a skill absent from the registry is refused before anything runs", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  await withServeServer(depsFor(root), async (base) => {
    const res = await post(base, { skill: "not-a-skill", mode: "clarify", taskId: "W1-T900" }, WRITE_TOKEN);
    assert.equal(res.status, 400);
    const before = readdirSync(join(root, "plan"));
    assert.ok(!before.includes("feedback"), "a rejected invocation must not have written a feedback entry");
  });
});

test("an unknown task is a 404 from the live route", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  await withServeServer(depsFor(root), async (base) => {
    const res = await post(base, { skill: "plan", mode: "clarify", taskId: "W1-T999" }, WRITE_TOKEN);
    assert.equal(res.status, 404);
  });
});
