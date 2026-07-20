import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildPanelSkillsRoutes, buildSkillsRoute, type PanelSkillsDeps } from "../src/lib/panel-skills.js";
import { skillsDir } from "../src/lib/skill.js";

// ── W3-T8: panel skill actions — each registry skill is a panel button wired to the registry ──
// (MASTER-PLAN §5B/§7)
//
// Acceptance (plan/tasks.yaml) this suite proves the READ half of (the "invoking Refine runs
// plan --mode=clarify + inline grill" WRITE half is test/panel-skill-run.test.ts's job — see
// src/lib/panel-skill-run.ts's header for how it composes already-merged primitives plus the
// "plan" skill's own registry-declared grounding_sources, round 3):
//   "each v1 skill appears as a panel button resolved from the registry (not hard-coded UI)...
//   adding a skill yaml adds a button with no UI code change" — proven below by asserting GET
//   /v1/skills returns EXACTLY the fixture registry's contents, and that dropping in an
//   additional `.remudero/skills/<name>.yaml` after the server is already listening changes the
//   NEXT response with zero code change on this module's part.
//
// Same discipline as test/panel-actions.test.ts / test/panel-graph.test.ts: real
// createService()/fetch() plumbing, never a mock of either. The registry loader itself
// (lib/skill.ts) is EXISTING and already covered by its own suite (test/skill.test.ts) — these
// tests exercise the WIRING (route registration, scope, live-reload).

const READ_TOKEN = "skills-read-token";
const WRITE_TOKEN = "skills-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-panel-skills-"));
}

function writeSkillYaml(root: string, name: string, overrides: Record<string, unknown> = {}): void {
  const dir = skillsDir(root);
  mkdirSync(dir, { recursive: true });
  const doc = {
    tools: ["Read", "Grep"],
    permission_profile: "implement",
    output_contract: "a PR",
    grounding_sources: ["plan/tasks.yaml"],
    gate: "ci + remudero-review",
    tier: "G-17",
    ...overrides,
  };
  const lines = Object.entries(doc).map(([key, value]) =>
    Array.isArray(value) ? `${key}:\n${(value as string[]).map((v) => `  - ${v}`).join("\n")}` : `${key}: ${JSON.stringify(value)}`,
  );
  writeFileSync(join(dir, `${name}.yaml`), lines.join("\n") + "\n");
}

function depsFor(root: string): PanelSkillsDeps {
  return { root };
}

async function withService<T>(deps: PanelSkillsDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildPanelSkillsRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function get(base: string, path: string, token?: string) {
  return fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
}

// ── route shape ──────────────────────────────────────────────────────────────

test("buildSkillsRoute: GET /v1/skills, read-scoped", () => {
  const route = buildSkillsRoute(depsFor(tmpRoot()));
  assert.equal(route.method, "GET");
  assert.equal(route.path, "/v1/skills");
  assert.equal(route.scope, "read");
});

test("buildPanelSkillsRoutes: today just the one route (no hard-coded per-skill route)", () => {
  const routes = buildPanelSkillsRoutes(depsFor(tmpRoot()));
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/v1/skills");
});

// ── scope enforcement (mirrors test/service.test.ts's generic proof) ────────────────────────

test("GET /v1/skills: no bearer token -> 401", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  await withService(depsFor(root), async (base) => {
    const res = await get(base, "/v1/skills");
    assert.equal(res.status, 401);
  });
});

test("GET /v1/skills: a write-scoped token also works (write is a superset of read)", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  await withService(depsFor(root), async (base) => {
    const res = await get(base, "/v1/skills", WRITE_TOKEN);
    assert.equal(res.status, 200);
  });
});

// ── the registry-generated button set ────────────────────────────────────────

test("GET /v1/skills: returns one entry per .remudero/skills/<name>.yaml, every field resolved", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan", { tier: "G-17", gate: "ci + remudero-review" });
  writeSkillYaml(root, "refactor", { tier: "G-16" });
  await withService(depsFor(root), async (base) => {
    const res = await get(base, "/v1/skills", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { skills: Array<{ name: string; tier: string; gate: string }> };
    const names = body.skills.map((s) => s.name).sort();
    assert.deepEqual(names, ["plan", "refactor"]);
    const plan = body.skills.find((s) => s.name === "plan")!;
    assert.equal(plan.tier, "G-17");
    assert.equal(plan.gate, "ci + remudero-review");
  });
});

test("GET /v1/skills: no registered skills yet -> an empty, non-throwing list", async () => {
  const root = tmpRoot();
  await withService(depsFor(root), async (base) => {
    const res = await get(base, "/v1/skills", READ_TOKEN);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { skills: [] });
  });
});

test("GET /v1/skills: dropping a NEW skill yaml in after the server is already listening appears on the very next request — zero UI/route code change (W3-T8's literal acceptance proof)", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  await withService(depsFor(root), async (base) => {
    const before = (await (await get(base, "/v1/skills", READ_TOKEN)).json()) as { skills: Array<{ name: string }> };
    assert.deepEqual(
      before.skills.map((s) => s.name),
      ["plan"],
    );

    // Config-only change: a fresh .remudero/skills/<name>.yaml, no restart, no route edit.
    writeSkillYaml(root, "design-review");

    const after = (await (await get(base, "/v1/skills", READ_TOKEN)).json()) as { skills: Array<{ name: string }> };
    assert.deepEqual(
      after.skills.map((s) => s.name).sort(),
      ["design-review", "plan"],
    );
  });
});

test("GET /v1/skills: a malformed shard fails the WHOLE load, surfaced as a 500 internal_error (not a silent partial registry)", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  mkdirSync(skillsDir(root), { recursive: true });
  writeFileSync(join(skillsDir(root), "broken.yaml"), "tools: []\n"); // empty tools array -> invalid
  await withService(depsFor(root), async (base) => {
    const res = await get(base, "/v1/skills", READ_TOKEN);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "internal_error");
  });
});

test("GET /v1/skills: the SHIPPED .remudero/skills/ registry resolves through this route exactly like `rmd skill list`", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  await withService(depsFor(repoRoot), async (base) => {
    const res = await get(base, "/v1/skills", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { skills: Array<{ name: string }> };
    const names = body.skills.map((s) => s.name).sort();
    assert.deepEqual(names, ["design-review", "feedback", "plan", "refactor", "retro", "review", "setup"]);
  });
});
