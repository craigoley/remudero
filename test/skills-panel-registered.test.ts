import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildServeRoutes, buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { skillsDir } from "../src/lib/skill.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

// ── W1-T284: the skills panel is dead code — panel-skills.ts was built (W3-T8) but never
// wired into `rmd serve`'s real route table, so GET /v1/skills 404'd on every running console
// even though the module (and its own suite, test/panel-skills.test.ts) worked perfectly in
// isolation. This suite proves the WIRING onto the assembled server — buildServeRoutes/
// buildServeServer, the SAME assembler `rmd serve` itself calls — never the module's own
// request-handling logic again (that's test/panel-skills.test.ts's job, same split
// test/serve.test.ts already draws against panel-actions.ts/panel-graph.ts).
//
// Acceptance (plan/tasks.yaml, W1-T284):
//   (1) "the skills route is registered on the console's real route table" — buildServeRoutes'
//       own output includes a GET /v1/skills entry.
//   (2) "a request to the skills endpoint returns the registry rather than a 404" — a live,
//       ephemeral-port buildServeServer() instance answers GET /v1/skills with the fixture
//       registry's contents, not a 404.
//   (3) "the route is read-scoped so a view never needs the write token" — the registered
//       route's `scope` is "read", and a READ-only token (never the write token) is enough to
//       fetch it end to end.
//   (4) "serve.ts references the skills panel module, so the pair is no longer externally
//       unimported" — proven by this suite's own existence plus the grep proof in the PR body
//       (`panel-skills.js` in `src/lib/serve.ts`); nothing to assert at runtime beyond (1)-(3).

const READ_TOKEN = "skills-panel-registered-read-token";
const WRITE_TOKEN = "skills-panel-registered-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-skills-panel-registered-"));
}

function writeSkillYaml(root: string, name: string): void {
  const dir = skillsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.yaml`),
    [
      `tools:\n  - Read`,
      `permission_profile: implement`,
      `output_contract: a PR`,
      `grounding_sources:\n  - plan/tasks.yaml`,
      `gate: ci + remudero-review`,
      `tier: G-17`,
      "",
    ].join("\n"),
  );
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function writePlan(root: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n", { flag: "wx" });
  return planPath;
}

function fakeGitHub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close: () => {} };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return { approve: () => {}, reframe: () => {} };
}

function planOf(): Plan {
  return { tasks: [], byId: new Map() };
}

function depsFor(root: string): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root);
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

function get(base: string, path: string, token?: string) {
  return fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
}

// ── (1) registered on the real route table ──────────────────────────────────

test("buildServeRoutes registers GET /v1/skills, read-scoped", () => {
  const routes = buildServeRoutes(depsFor(tmpRoot()));
  const skillsRoute = routes.find((r) => r.method === "GET" && r.path === "/v1/skills");
  assert.ok(skillsRoute, "expected GET /v1/skills in buildServeRoutes' output");
  assert.equal(skillsRoute!.scope, "read");
});

// ── (2) returns the registry, not a 404 ─────────────────────────────────────

test("GET /v1/skills on the live assembled server returns the registry", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  writeSkillYaml(root, "retro");
  await withServeServer(depsFor(root), async (base) => {
    const res = await get(base, "/v1/skills", READ_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { skills: Array<{ name: string }> };
    const names = body.skills.map((s) => s.name).sort();
    assert.deepEqual(names, ["plan", "retro"]);
  });
});

// ── (3) read-scoped: a read token alone is enough, no token 401s ───────────

test("GET /v1/skills is satisfied by the read token alone", async () => {
  const root = tmpRoot();
  writeSkillYaml(root, "plan");
  await withServeServer(depsFor(root), async (base) => {
    const readRes = await get(base, "/v1/skills", READ_TOKEN);
    assert.equal(readRes.status, 200);

    const anonRes = await get(base, "/v1/skills");
    assert.equal(anonRes.status, 401);
  });
});
