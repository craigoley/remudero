/**
 * test/onboarding-readiness.test.ts — W1-T4264.
 *
 * A candidate repo's readiness report: eight checks read through the Fleet GitHub App, each
 * pass / warn / fail / unknown with its reason, served at `GET /v1/onboarding/readiness`. Every
 * GitHub read here is a scripted gateway or a PATH-shim `gh`; every registry is a temp file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  onboardingReadiness,
  onboardingReadinessGateway,
  type OnboardingReadinessApiRead,
  type OnboardingReadinessCheck,
  type OnboardingReadinessGateway,
  type OnboardingReadinessStatus,
} from "../src/lib/onboarding-readiness.js";
import { buildOnboardingReadinessRoute, buildServeRoutes, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

type Contents = Record<string, OnboardingReadinessApiRead | undefined>;

const ok = (body: unknown): OnboardingReadinessApiRead => ({ status: 200, body });
const status = (code: number): OnboardingReadinessApiRead => ({ status: code, body: undefined });
const file = (text: string): OnboardingReadinessApiRead => ok({ content: Buffer.from(text).toString("base64"), encoding: "base64" });

/** A fully ready repo; each test overrides only the reads it is about. */
function gateway(over: {
  installed?: string[] | undefined;
  repo?: OnboardingReadinessApiRead | undefined;
  protection?: OnboardingReadinessApiRead | undefined;
  contents?: Contents;
} = {}): OnboardingReadinessGateway & { protectionBranches: string[] } {
  const contents: Contents = {
    ".github/workflows": ok([{ name: "ci.yml" }, { name: "README.md" }]),
    "AGENTS.md": ok({}),
    "CLAUDE.md": status(404),
    "package.json": file(JSON.stringify({ scripts: { test: "node --test" } })),
    Makefile: status(404),
    "pyproject.toml": status(404),
    plan: ok([{ name: "tasks.yaml" }]),
    ...over.contents,
  };
  const protectionBranches: string[] = [];
  return {
    protectionBranches,
    listInstallationRepos: () => ("installed" in over ? over.installed : ["acme/widget", "acme/other"]),
    getRepo: () => ("repo" in over ? over.repo : ok({ default_branch: "main" })),
    getBranchProtection: (_o, _r, branch) => {
      protectionBranches.push(branch);
      return "protection" in over ? over.protection : ok({ required_status_checks: { contexts: ["ci", 7] } });
    },
    getContents: (_o, _r, path) => contents[path],
  };
}

function byId(checks: OnboardingReadinessCheck[]): Record<string, OnboardingReadinessCheck> {
  return Object.fromEntries(checks.map((c) => [c.id, c]));
}

function statusOf(g: OnboardingReadinessGateway, id: string, registry = { repos: [] as string[] }): [OnboardingReadinessStatus, string] {
  const c = byId(onboardingReadiness("acme", "widget", registry, g).checks)[id]!;
  return [c.status, c.reason];
}

test("a ready repository passes all eight checks, each carrying its evidence", () => {
  const g = gateway();
  const report = onboardingReadiness("acme", "widget", { repos: ["acme/elsewhere"] }, g);
  assert.equal(report.repo, "acme/widget");
  assert.deepEqual(
    report.checks.map((c) => [c.id, c.status]),
    [
      ["app-access", "pass"],
      ["default-branch", "pass"],
      ["branch-protection", "pass"],
      ["ci-workflows", "pass"],
      ["agent-instructions", "pass"],
      ["test-command", "pass"],
      ["plan-layout", "pass"],
      ["already-onboarded", "pass"],
    ],
  );
  const checks = byId(report.checks);
  assert.equal(checks["branch-protection"]!.evidence, "ci", "only string contexts are required checks");
  assert.equal(checks["ci-workflows"]!.evidence, "ci.yml", "only .yml/.yaml files are workflows");
  assert.equal(checks["test-command"]!.evidence, "npm test — node --test");
  assert.equal(checks["plan-layout"]!.evidence, undefined);
  assert.deepEqual(g.protectionBranches, ["main"], "protection is read on the repo's own default branch");
});

test("a repository the app cannot see fails app access with the reason", () => {
  const [state, reason] = statusOf(gateway({ installed: ["acme/other"] }), "app-access");
  assert.equal(state, "fail");
  assert.match(reason, /acme\/widget is not listed among the Fleet GitHub App's installation repositories/);
  assert.equal(statusOf(gateway({ installed: ["ACME/Widget"] }), "app-access")[0], "pass", "owner/name compares case-insensitively");
});

test("a failed GitHub read reports unknown never pass", () => {
  const failed: OnboardingReadinessGateway = {
    listInstallationRepos: () => undefined,
    getRepo: () => undefined,
    getBranchProtection: () => undefined,
    getContents: () => undefined,
  };
  const checks = onboardingReadiness("acme", "widget", { repos: [] }, failed).checks;
  const github = checks.filter((c) => c.id !== "already-onboarded");
  assert.equal(github.length, 7);
  for (const c of github) assert.equal(c.status, "unknown", `${c.id} must read unknown, not ${c.status}: ${c.reason}`);
  assert.equal(byId(checks)["branch-protection"]!.reason, "default branch unknown — cannot check its protection");

  // A protection read that itself fails, on a known branch, is unknown too — never a confirmed "no protection".
  assert.deepEqual(statusOf(gateway({ protection: undefined }), "branch-protection"), ["unknown", "branch protection read failed"]);
  // One failed AGENTS.md/CLAUDE.md read beside a confirmed absence is still unknown, not "none found".
  assert.equal(statusOf(gateway({ contents: { "AGENTS.md": status(404), "CLAUDE.md": undefined } }), "agent-instructions")[0], "unknown");
  // A failed test-command read with nothing else found is unknown, not "no test command".
  assert.equal(statusOf(gateway({ contents: { "package.json": undefined } }), "test-command")[0], "unknown");
});

test("a repository already in the registry reads as already onboarded", () => {
  const [state, reason] = statusOf(gateway(), "already-onboarded", { repos: ["Acme/Widget"] });
  assert.equal(state, "warn");
  assert.match(reason, /already onboarded in the fleet registry — do not create a second instance/);
  const unreadable = byId(onboardingReadiness("acme", "widget", { unreadable: "duplicate_instance" }, gateway()).checks);
  assert.equal(unreadable["already-onboarded"]!.status, "unknown", "an unreadable registry never reads as not-yet-onboarded");
  assert.match(unreadable["already-onboarded"]!.reason, /duplicate_instance/);
});

test("a definitive 404 is a confirmed negative and any other status is unknown", () => {
  assert.deepEqual(statusOf(gateway({ repo: status(404) }), "default-branch"), ["fail", "acme/widget was not found"]);
  assert.equal(statusOf(gateway({ repo: status(403) }), "default-branch")[0], "unknown");
  assert.equal(statusOf(gateway({ repo: ok({}) }), "default-branch")[0], "unknown", "no default_branch carried");
  assert.equal(statusOf(gateway({ repo: undefined }), "default-branch")[0], "unknown");

  assert.equal(statusOf(gateway({ protection: status(404) }), "branch-protection")[0], "fail");
  assert.equal(statusOf(gateway({ protection: status(500) }), "branch-protection")[0], "unknown");
  assert.equal(statusOf(gateway({ protection: ok({}) }), "branch-protection")[0], "warn", "protected, no required checks");

  const workflows = (read: OnboardingReadinessApiRead | undefined) => statusOf(gateway({ contents: { ".github/workflows": read } }), "ci-workflows")[0];
  assert.equal(workflows(status(404)), "fail");
  assert.equal(workflows(status(502)), "unknown");
  assert.equal(workflows(undefined), "unknown");
  assert.equal(workflows(ok([{ name: "notes.txt" }])), "warn");
  assert.equal(workflows(ok({ not: "a directory" })), "warn");

  const plan = (read: OnboardingReadinessApiRead | undefined) => statusOf(gateway({ contents: { plan: read } }), "plan-layout")[0];
  assert.equal(plan(status(404)), "warn");
  assert.equal(plan(status(500)), "unknown");
  assert.equal(plan(undefined), "unknown");
});

test("agent instructions and the test command name which file answered", () => {
  const agents = (a: OnboardingReadinessApiRead | undefined, c: OnboardingReadinessApiRead | undefined) =>
    statusOf(gateway({ contents: { "AGENTS.md": a, "CLAUDE.md": c } }), "agent-instructions");
  assert.deepEqual(agents(ok({}), ok({})), ["pass", "AGENTS.md and CLAUDE.md both present"]);
  assert.deepEqual(agents(status(404), ok({})), ["pass", "CLAUDE.md present"]);
  assert.deepEqual(agents(status(404), status(404)), ["warn", "no AGENTS.md or CLAUDE.md found"]);

  const tests = (contents: Contents) => statusOf(gateway({ contents }), "test-command");
  const absent = { "package.json": status(404), Makefile: status(404), "pyproject.toml": status(404) };
  assert.deepEqual(tests({ ...absent, Makefile: ok({}) }), ["pass", "Makefile present"]);
  assert.deepEqual(tests({ ...absent, "pyproject.toml": ok({}) }), ["pass", "pyproject.toml present"]);
  assert.equal(tests(absent)[0], "warn");
  assert.equal(tests({ ...absent, "package.json": file('{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}') })[0], "warn");
  assert.equal(tests({ ...absent, "package.json": file("{ not json") })[0], "warn", "an unparsable package.json declares no script");
  assert.equal(tests({ ...absent, "package.json": ok({ content: 42 }) })[0], "warn");
  assert.equal(tests({ ...absent, "package.json": ok({ content: '{"scripts":{"test":"jest"}}' }) })[0], "pass", "a non-base64 content is read as text");
});

test("the gateway classifies each gh api answer by its HTTP status, and only an unreadable call as undefined", () => {
  const calls: string[][] = [];
  const answers: Record<string, () => string> = {
    "installation/repositories?per_page=100": () => 'HTTP/2.0 200 OK\r\nX-Header: 1\r\n\r\n{"repositories":[{"full_name":"acme/widget"},{"id":3},null]}',
    "repos/acme/widget": () => '{"default_branch":"trunk"}',
    "repos/acme/widget/branches/trunk/protection": () => {
      throw Object.assign(new Error("exit 1"), { stderr: "gh: Branch not protected (HTTP 404)\n" });
    },
    "repos/acme/widget/contents/plan": () => "HTTP/2.0 204 No Content\r\n\r\n",
    "repos/acme/widget/contents/AGENTS.md": () => "HTTP/2.0 200 OK\r\n\r\n<html>not json</html>",
    "repos/acme/widget/contents/CLAUDE.md": () => {
      throw new Error("connect ECONNREFUSED");
    },
    "repos/acme/widget/contents/Makefile": () => {
      throw new Error("gh: Server Error (HTTP 503)");
    },
  };
  const g = onboardingReadinessGateway((args) => {
    calls.push(args);
    return answers[args[1]!]!();
  });
  assert.deepEqual(g.listInstallationRepos(), ["acme/widget"]);
  assert.deepEqual(g.getRepo("acme", "widget"), { status: 200, body: { default_branch: "trunk" } });
  assert.deepEqual(g.getBranchProtection("acme", "widget", "trunk"), { status: 404, body: undefined });
  assert.deepEqual(g.getContents("acme", "widget", "plan"), { status: 204, body: undefined });
  assert.equal(g.getContents("acme", "widget", "AGENTS.md"), undefined, "a 2xx with an unparsable body is a failed read");
  assert.equal(g.getContents("acme", "widget", "CLAUDE.md"), undefined, "a transport failure names no status");
  assert.deepEqual(g.getContents("acme", "widget", "Makefile"), { status: 503, body: undefined });
  for (const args of calls) assert.deepEqual([args[0], args[2], args.length], ["api", "-i", 3], "a bare GET, never a write flag");

  const listing = (raw: () => string) => onboardingReadinessGateway(() => raw()).listInstallationRepos();
  assert.equal(listing(() => '{"repositories":"nope"}'), undefined);
  assert.equal(listing(() => "HTTP/2.0 403 Forbidden\r\n\r\n{}"), undefined);
  assert.equal(
    listing(() => {
      throw new Error("no network");
    }),
    undefined,
  );
});

test("the default gateway really shells out to gh", (t) => {
  const shim = ghShim([
    { when: "installation/repositories", stdout: '{"repositories":[{"full_name":"acme/widget"}]}' },
    { when: "repos/acme/widget/branches", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "repos/acme/widget/contents", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "repos/acme/widget", stdout: '{"default_branch":"main"}' },
  ]);
  const previous = { PATH: process.env.PATH, RMD_GH_CACHE_HOME: process.env.RMD_GH_CACHE_HOME };
  process.env.PATH = `${shim.dir}:${previous.PATH}`;
  process.env.RMD_GH_CACHE_HOME = shim.dir;
  t.after(() => {
    process.env.PATH = previous.PATH;
    if (previous.RMD_GH_CACHE_HOME === undefined) delete process.env.RMD_GH_CACHE_HOME;
    else process.env.RMD_GH_CACHE_HOME = previous.RMD_GH_CACHE_HOME;
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const checks = byId(onboardingReadiness("acme", "widget", { repos: [] }).checks);
  assert.equal(checks["app-access"]!.status, "pass");
  assert.equal(checks["default-branch"]!.evidence, "main");
  assert.equal(checks["branch-protection"]!.status, "fail");
  assert.equal(checks["plan-layout"]!.status, "warn");
  assert.ok(shim.calls().some((c) => c.startsWith("api repos/acme/widget/branches/main/protection")));
});

// ── The route ────────────────────────────────────────────────────────────────────────────────

const REGISTRY = [
  "instances:",
  "  core:",
  "    github_repo: acme/widget",
  "  gone:",
  "    github_repo: acme/retired",
  "    retired: true",
  "",
].join("\n");

function fixtureDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4264-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function invoke(route: Route, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let code = 0;
  let text = "";
  const res = {
    writeHead(c: number) {
      code = c;
    },
    end(chunk?: string) {
      text += chunk ?? "";
    },
  };
  await route.handler({ url } as never, res as never, { params: {} });
  return { status: code, body: JSON.parse(text) as Record<string, unknown> };
}

function checkStatus(body: Record<string, unknown>, id: string): OnboardingReadinessCheck {
  return byId(body.checks as OnboardingReadinessCheck[])[id]!;
}

test("the readiness route refuses a missing or malformed repo and answers a valid one from the registry", async (t) => {
  const dir = fixtureDir(t);
  const repoRegistryPath = join(dir, "registry.yaml");
  writeFileSync(repoRegistryPath, REGISTRY);
  const route = buildOnboardingReadinessRoute({ repoRegistryPath, gateway: gateway() });
  assert.deepEqual([route.method, route.path, route.scope], ["GET", "/v1/onboarding/readiness", "read"]);

  for (const url of ["/v1/onboarding/readiness", "/v1/onboarding/readiness?repo=widget", "/v1/onboarding/readiness?repo=a/b/c"]) {
    const refused = await invoke(route, url);
    assert.equal(refused.status, 400, url);
    assert.equal(refused.body.error, "invalid_request");
  }

  const live = await invoke(route, "/v1/onboarding/readiness?repo=acme/widget");
  assert.equal(live.status, 200);
  assert.equal(live.body.repo, "acme/widget");
  assert.equal(checkStatus(live.body, "already-onboarded").status, "warn");

  const retired = await invoke(route, "/v1/onboarding/readiness?repo=acme/retired");
  assert.equal(checkStatus(retired.body, "already-onboarded").status, "pass", "a retired row is not an onboarded repo");
});

test("an unreadable or invalid registry makes only already-onboarded unknown, with no path in the answer", async (t) => {
  const dir = fixtureDir(t);
  const missing = await invoke(buildOnboardingReadinessRoute({ repoRegistryPath: join(dir, "absent.yaml"), gateway: gateway() }), "/?repo=acme/widget");
  assert.equal(missing.status, 200);
  assert.deepEqual(
    [checkStatus(missing.body, "already-onboarded").status, checkStatus(missing.body, "already-onboarded").reason],
    ["unknown", "the fleet registry could not be read (unreadable)"],
  );
  assert.equal(checkStatus(missing.body, "app-access").status, "pass", "the other checks still ship");
  assert.ok(!JSON.stringify(missing.body).includes(dir));

  const invalidPath = join(dir, "invalid.yaml");
  writeFileSync(invalidPath, "instances:\n  a:\n    github_repo: not-owner-name\n");
  const invalid = await invoke(buildOnboardingReadinessRoute({ repoRegistryPath: invalidPath, gateway: gateway() }), "/?repo=acme/widget");
  assert.match(checkStatus(invalid.body, "already-onboarded").reason, /\(invalid_repo\)/);
});

test("the served routes mount the readiness route on the registry buildRegistryRoute reads", async (t) => {
  const dir = fixtureDir(t);
  const repoRegistryPath = join(dir, "registry.yaml");
  writeFileSync(repoRegistryPath, REGISTRY);
  const deps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath: join(dir, "ledger.ndjson"), github: {} },
    panelGraph: {
      root: dir,
      planPath: join(dir, "tasks.yaml"),
      ledgerPath: join(dir, "ledger.ndjson"),
      github: { prView: () => null },
      statusGithub: {},
      ratify: { approve() {}, reframe() {} },
    },
    issues: { close() {} },
    ledgerPath: join(dir, "ledger.ndjson"),
    fleetControlRoot: dir,
    questionsRoot: dir,
    tokens: { read: "r", write: "w" },
    githubAppRefresh: { start: () => ({ armed: false }) },
    log: () => {},
    registry: { repoRegistryPath },
    onboardingReadiness: { gateway: gateway() },
  } as unknown as ServeDeps;
  const route = buildServeRoutes(deps).find((r) => r.path === "/v1/onboarding/readiness");
  assert.ok(route, "the readiness route is mounted");
  const answer = await invoke(route, "/v1/onboarding/readiness?repo=acme/widget");
  assert.equal(checkStatus(answer.body, "already-onboarded").status, "warn", "it read the registry route's own path");
});
