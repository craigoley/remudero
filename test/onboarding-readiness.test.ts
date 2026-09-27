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
  onboardingReadinessGatewayAsync,
  readOnboardingReadinessSnapshot,
  type OnboardingReadinessApiRead,
  type OnboardingReadinessCheck,
  type OnboardingReadinessGateway,
  type OnboardingReadinessGatewayAsync,
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
  rules?: OnboardingReadinessApiRead | undefined;
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
    getBranchRules: () => ("rules" in over ? over.rules : ok([])),
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
    getBranchRules: () => undefined,
    getContents: () => undefined,
  };
  const checks = onboardingReadiness("acme", "widget", { repos: [] }, failed).checks;
  const github = checks.filter((c) => c.id !== "already-onboarded");
  assert.equal(github.length, 7);
  for (const c of github) assert.equal(c.status, "unknown", `${c.id} must read unknown, not ${c.status}: ${c.reason}`);
  assert.equal(byId(checks)["branch-protection"]!.reason, "default branch unknown — cannot check its protection");

  // A protection read that itself fails, on a known branch, is unknown too — never a confirmed "no protection".
  assert.deepEqual(statusOf(gateway({ protection: undefined }), "branch-protection"), ["unknown", "classic protection or active rulesets could not be read completely"]);
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

test("active rulesets protect a branch even when classic protection returns 404", () => {
  const required = ok([{ type: "required_status_checks", ruleset_source_type: "Organization", parameters: { required_status_checks: [{ context: "org-ci" }] } }]);
  const report = byId(onboardingReadiness("acme", "widget", { repos: [] }, gateway({ protection: status(404), rules: required })).checks);
  assert.equal(report["branch-protection"]!.status, "pass");
  assert.equal(report["branch-protection"]!.evidence, "org-ci");
  assert.match(report["branch-protection"]!.reason, /active rulesets/);

  assert.equal(statusOf(gateway({ protection: status(404), rules: ok([{ type: "pull_request" }]) }), "branch-protection")[0], "warn");
  assert.equal(statusOf(gateway({ protection: status(404), rules: ok([]) }), "branch-protection")[0], "fail");
  assert.equal(statusOf(gateway({ protection: status(404), rules: undefined }), "branch-protection")[0], "unknown");
  assert.equal(statusOf(gateway({ protection: status(404), rules: ok({ not: "a rule list" }) }), "branch-protection")[0], "unknown");
  assert.equal(statusOf(gateway({ protection: status(404), rules: ok([{ type: "required_status_checks", parameters: {} }]) }), "branch-protection")[0], "unknown");
  assert.equal(statusOf(gateway({ protection: undefined, rules: required }), "branch-protection")[0], "pass", "the active ruleset proves required checks even if classic read fails");
  assert.equal(statusOf(gateway({ protection: ok({}), rules: undefined }), "branch-protection")[0], "unknown", "missing ruleset evidence cannot prove there are no required checks");
  assert.equal(statusOf(gateway({ protection: ok({ required_status_checks: { checks: [{ context: "classic-ci" }] } }) }), "branch-protection")[0], "pass", "the modern classic checks list is counted too");
  assert.equal(statusOf(gateway({ protection: ok({ required_status_checks: { checks: [{}] } }) }), "branch-protection")[0], "unknown", "a malformed classic checks list is not an absence");
});

test("the async readiness snapshot carries active rules into the served classifier", async () => {
  const source = gateway({ protection: status(404), rules: ok([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "org-ci" }] } }]) });
  const snapshot = await readOnboardingReadinessSnapshot("acme", "widget", {
    listInstallationRepos: async () => source.listInstallationRepos(),
    getRepo: async (...args) => source.getRepo(...args),
    getBranchProtection: async (...args) => source.getBranchProtection(...args),
    getBranchRules: async (...args) => source.getBranchRules(...args),
    getContents: async (...args) => source.getContents(...args),
  });
  assert.equal(snapshot.complete, true);
  const report = byId(onboardingReadiness("acme", "widget", { repos: [] }, snapshot).checks);
  assert.equal(report["branch-protection"]!.status, "pass");
  assert.equal(report["branch-protection"]!.evidence, "org-ci");
});

test("the gateway URL-encodes a default branch with a slash for both protection APIs", () => {
  const calls: string[][] = [];
  const g = onboardingReadinessGateway((args) => { calls.push(args); return "[[]]"; });
  g.getBranchProtection("acme", "widget", "release/next");
  g.getBranchRules("acme", "widget", "release/next");
  assert.deepEqual(calls.map((args) => args[1]), [
    "repos/acme/widget/branches/release%2Fnext/protection",
    "repos/acme/widget/rules/branches/release%2Fnext?per_page=100",
  ]);
});

test("branch rules are complete across pages, and a malformed page cannot prove no checks", async () => {
  const firstPage = Array.from({ length: 100 }, () => ({ type: "pull_request" }));
  const lastPage = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "late-ci" }] } }];
  const paginated = JSON.stringify([firstPage, lastPage]);
  const argsSeen: string[][] = [];
  const sync = onboardingReadinessGateway((args) => { argsSeen.push(args); return paginated; });
  const fixture = gateway({ protection: status(404) });
  const report = byId(onboardingReadiness("acme", "widget", { repos: [] }, { ...fixture, getBranchRules: sync.getBranchRules }).checks);
  assert.equal(report["branch-protection"]!.status, "pass");
  assert.equal(report["branch-protection"]!.evidence, "late-ci");
  assert.deepEqual(argsSeen, [["api", "repos/acme/widget/rules/branches/main?per_page=100", "--paginate", "--slurp"]]);

  const asyncRules = onboardingReadinessGatewayAsync(async () => paginated);
  assert.deepEqual(await asyncRules.getBranchRules("acme", "widget", "main"), { status: 200, body: [...firstPage, ...lastPage] });
  const partial = onboardingReadinessGateway(() => JSON.stringify([firstPage, { malformed: true }]));
  assert.equal(partial.getBranchRules("acme", "widget", "main"), undefined);
  assert.equal(statusOf({ ...fixture, getBranchRules: partial.getBranchRules }, "branch-protection")[0], "unknown");
  assert.equal(onboardingReadinessGateway(() => "[]").getBranchRules("acme", "widget", "main"), undefined, "zero pages is not an empty active-rules result");
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
    "installation/repositories?per_page=100": () => "1\nacme/widget\n",
    "repos/acme/widget": () => '{"default_branch":"trunk"}',
    "repos/acme/widget/branches/trunk/protection": () => {
      throw Object.assign(new Error("exit 1"), { stderr: "gh: Branch not protected (HTTP 404)\n" });
    },
    "repos/acme/widget/rules/branches/trunk?per_page=100": () => "[[]]",
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
  assert.deepEqual(g.getBranchRules("acme", "widget", "trunk"), { status: 200, body: [] });
  assert.deepEqual(g.getContents("acme", "widget", "plan"), { status: 204, body: undefined });
  assert.equal(g.getContents("acme", "widget", "AGENTS.md"), undefined, "a 2xx with an unparsable body is a failed read");
  assert.equal(g.getContents("acme", "widget", "CLAUDE.md"), undefined, "a transport failure names no status");
  assert.deepEqual(g.getContents("acme", "widget", "Makefile"), { status: 503, body: undefined });
  for (const args of calls) {
    assert.equal(args[0], "api");
    if (args[1]?.startsWith("installation/")) assert.deepEqual(args.slice(2), ["--paginate", "--jq", ".total_count, .repositories[].full_name"]);
    else if (args[1]?.includes("/rules/branches/")) assert.deepEqual(args.slice(2), ["--paginate", "--slurp"]);
    else assert.deepEqual([args[2], args.length], ["-i", 3], "metadata remains a bare GET, never a write flag");
  }

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

test("the async gateway preserves definitive HTTP absence and incomplete installation evidence", async () => {
  const calls: string[][] = [];
  const asyncGateway = onboardingReadinessGatewayAsync(async (args) => {
    calls.push(args);
    if (args[1]?.startsWith("installation/")) return "2\nacme/widget\n";
    if (args[1]?.endsWith("/protection")) throw Object.assign(new Error("exit 1"), { stderr: "gh: Not Found (HTTP 404)" });
    if (args[1] === "repos/acme/widget") return '{"default_branch":"main"}';
    throw new Error("network unavailable");
  });
  const snapshot = await readOnboardingReadinessSnapshot("acme", "widget", asyncGateway);
  assert.equal(snapshot.listInstallationRepos(), undefined, "a truncated page cannot prove app absence");
  assert.deepEqual(snapshot.getBranchProtection("acme", "widget", "main"), { status: 404, body: undefined });
  assert.equal(snapshot.complete, false, "incomplete reads must not enter the warm cache");
  assert.ok(calls.every((args) => args[0] === "api"));
});

test("readiness checks Fleet App access beyond the first hundred repositories and refuses a partial list", () => {
  const names = Array.from({ length: 101 }, (_, index) => `acme/repo-${index}`);
  names[100] = "acme/widget";
  const raw = `101\n${names.slice(0, 100).join("\n")}\n101\n${names[100]}\n`;
  const complete = onboardingReadinessGateway(() => raw);
  assert.deepEqual(statusOf(complete, "app-access"), ["pass", "acme/widget is listed in the Fleet GitHub App's installation"]);
  const partial = onboardingReadinessGateway(() => `101\n${names.slice(0, 100).join("\n")}\n`);
  assert.equal(statusOf(partial, "app-access")[0], "unknown", "an incomplete listing cannot prove the app lacks the repository");
});

test("the default gateway really shells out to gh", (t) => {
  const shim = ghShim([
    { when: "installation/repositories", stdout: "1\nacme/widget\n" },
    { when: "repos/acme/widget/branches", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "repos/acme/widget/rules/branches", stdout: "[[]]" },
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

test("the served readiness route does not block on GitHub and re-reads the registry on a warm GitHub snapshot", async (t) => {
  const dir = fixtureDir(t);
  const repoRegistryPath = join(dir, "registry.yaml");
  writeFileSync(repoRegistryPath, REGISTRY);
  const sync = gateway();
  let calls = 0;
  let releaseRepo: (() => void) | undefined;
  let markRepoStarted: (() => void) | undefined;
  const repoStarted = new Promise<void>((resolve) => { markRepoStarted = resolve; });
  const asyncGateway: OnboardingReadinessGatewayAsync = {
    listInstallationRepos: async () => { calls++; return sync.listInstallationRepos(); },
    getRepo: async () => {
      calls++;
      markRepoStarted!();
      await new Promise<void>((resolve) => { releaseRepo = resolve; });
      return sync.getRepo("acme", "widget");
    },
    getBranchProtection: async (...args) => { calls++; return sync.getBranchProtection(...args); },
    getBranchRules: async (...args) => { calls++; return sync.getBranchRules(...args); },
    getContents: async (...args) => { calls++; return sync.getContents(...args); },
  };
  const route = buildOnboardingReadinessRoute({ repoRegistryPath, asyncGateway });
  const pending = invoke(route, "/v1/onboarding/readiness?repo=acme/widget");
  const concurrent = invoke(route, "/v1/onboarding/readiness?repo=acme/widget");
  await repoStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseRepo, "function", "the GitHub read yielded to the event loop");
  releaseRepo!();
  const [first, joined] = await Promise.all([pending, concurrent]);
  assert.equal(checkStatus(first.body, "already-onboarded").status, "warn");
  assert.equal(checkStatus(joined.body, "app-access").status, "pass");
  const firstCalls = calls;
  writeFileSync(repoRegistryPath, "instances:\n  gone:\n    github_repo: acme/widget\n    retired: true\n");
  const second = await invoke(route, "/v1/onboarding/readiness?repo=acme/widget");
  assert.equal(checkStatus(second.body, "already-onboarded").status, "pass", "registry truth is not cached with GitHub evidence");
  assert.equal(calls, firstCalls, "the complete GitHub snapshot was reused");
});

test("an incomplete GitHub readiness snapshot is retried, never cached as app absence", async (t) => {
  const dir = fixtureDir(t);
  const repoRegistryPath = join(dir, "registry.yaml");
  writeFileSync(repoRegistryPath, REGISTRY);
  const sync = gateway();
  let installationReads = 0;
  const asyncGateway: OnboardingReadinessGatewayAsync = {
    listInstallationRepos: async () => {
      if (++installationReads === 1) throw new Error("GitHub read refused");
      return sync.listInstallationRepos();
    },
    getRepo: async (...args) => sync.getRepo(...args),
    getBranchProtection: async (...args) => sync.getBranchProtection(...args),
    getBranchRules: async (...args) => sync.getBranchRules(...args),
    getContents: async (...args) => sync.getContents(...args),
  };
  const route = buildOnboardingReadinessRoute({ repoRegistryPath, asyncGateway });
  const first = await invoke(route, "/?repo=acme/widget");
  assert.equal(checkStatus(first.body, "app-access").status, "unknown");
  const second = await invoke(route, "/?repo=acme/widget");
  assert.equal(checkStatus(second.body, "app-access").status, "pass");
  assert.equal(installationReads, 2);
});

test("a complete readiness snapshot expires after its short TTL, including if the clock moves backward", async (t) => {
  const dir = fixtureDir(t);
  const repoRegistryPath = join(dir, "registry.yaml");
  writeFileSync(repoRegistryPath, REGISTRY);
  const sync = gateway();
  let nowMs = 100_000;
  let installationReads = 0;
  const route = buildOnboardingReadinessRoute({
    repoRegistryPath,
    clock: { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() },
    asyncGateway: {
      listInstallationRepos: async () => { installationReads++; return sync.listInstallationRepos(); },
      getRepo: async (...args) => sync.getRepo(...args),
      getBranchProtection: async (...args) => sync.getBranchProtection(...args),
      getBranchRules: async (...args) => sync.getBranchRules(...args),
      getContents: async (...args) => sync.getContents(...args),
    },
  });
  await invoke(route, "/?repo=acme/widget");
  nowMs += 29_999;
  await invoke(route, "/?repo=acme/widget");
  assert.equal(installationReads, 1);
  nowMs += 1;
  await invoke(route, "/?repo=acme/widget");
  assert.equal(installationReads, 2);
  nowMs -= 30_001;
  await invoke(route, "/?repo=acme/widget");
  assert.equal(installationReads, 3, "a backward clock must not keep evidence warm forever");
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
