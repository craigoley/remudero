import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  buildOnboardingRepositoryInventoryRoute,
  readOnboardingRepositoryInventory,
} from "../src/lib/onboarding-repository-inventory.js";
import type { Route } from "../src/lib/service.js";
import { ghShim } from "./helpers/gh-shim.js";

async function invoke(route: Route): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let body = "";
  const response = {
    writeHead(code: number) { status = code; },
    end(chunk?: string) { body += chunk ?? ""; },
  };
  await route.handler({ url: "/v1/onboarding/repositories" } as never, response as never, { params: {} });
  return { status, body: JSON.parse(body) as Record<string, unknown> };
}

test("installation inventory consumes every paginated GitHub App result and names no credential", async () => {
  const args: string[][] = [];
  const result = await readOnboardingRepositoryInventory(async (argv) => {
    args.push(argv);
    return "3\nacme/one\nacme/two\n3\nacme/three\n";
  }, fixedClock(Date.parse("2026-09-27T12:00:00Z")));
  assert.deepEqual(result, {
    state: "verified",
    source: "fleet-app-installation",
    observed_at: "2026-09-27T12:00:00.000Z",
    repositories: ["acme/one", "acme/three", "acme/two"],
    total_count: 3,
  });
  assert.deepEqual(args, [["api", "installation/repositories?per_page=100", "--paginate", "--jq", ".total_count, .repositories[].full_name"]]);
  assert.ok(!JSON.stringify(result).includes("token"));
});

test("incomplete or malformed installation pages fail closed rather than showing a partial inventory", async () => {
  for (const raw of ["3\nacme/one\nacme/two\n", "2\nacme/one\n3\nacme/two\n", "2\nacme/one\nmalformed\n", ""]) {
    assert.deepEqual(await readOnboardingRepositoryInventory(async () => raw), { state: "unavailable", reason: "incomplete_or_invalid_listing" });
  }
});

test("a user-token fallback is distinguished from Fleet App verification and also paginates", async () => {
  const calls: string[][] = [];
  const result = await readOnboardingRepositoryInventory(async (argv) => {
    calls.push(argv);
    if (argv[1]?.startsWith("installation/")) throw new Error("HTTP 404 with private details");
    return "acme/second\nacme/first\n";
  });
  assert.deepEqual(result, {
    state: "verified",
    source: "daemon-user-token",
    observed_at: result.state === "verified" ? result.observed_at : "",
    repositories: ["acme/first", "acme/second"],
    total_count: 2,
  });
  assert.deepEqual(calls[1], ["api", "user/repos?affiliation=owner,collaborator,organization_member&per_page=100", "--paginate", "--jq", ".[].full_name"]);
});

test("a failed GitHub read returns only a generic unavailable reason and retries later", async () => {
  let calls = 0;
  const route = buildOnboardingRepositoryInventoryRoute({ read: async () => { calls += 1; throw new Error("credential ghp_should_never_leak"); } });
  const first = await invoke(route);
  const second = await invoke(route);
  assert.equal(first.status, 503);
  assert.deepEqual(first.body, { state: "unavailable", reason: "github_read_failed" });
  assert.deepEqual(second.body, first.body);
  assert.equal(calls, 4, "two source attempts per request; failures are never cached");
});

test("the read-scoped inventory route caches verified names for one minute without claiming readiness", async () => {
  let calls = 0;
  const route = buildOnboardingRepositoryInventoryRoute({
    clock: fixedClock(Date.parse("2026-09-27T12:00:00Z")),
    read: async () => { calls += 1; return "1\nacme/one\n"; },
  });
  assert.deepEqual([route.method, route.path, route.scope], ["GET", "/v1/onboarding/repositories", "read"]);
  const first = await invoke(route);
  const second = await invoke(route);
  assert.equal(first.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(calls, 1);
  assert.equal(first.body.source, "fleet-app-installation");
  assert.ok(!JSON.stringify(first.body).includes("ready"));
});

test("concurrent inventory requests share one GitHub read and expire after sixty seconds", async () => {
  let now = Date.parse("2026-09-27T12:00:00Z");
  let calls = 0;
  let release: ((raw: string) => void) | undefined;
  const clock = {
    now: () => now,
    date: () => new Date(now),
    iso: () => new Date(now).toISOString(),
  };
  const route = buildOnboardingRepositoryInventoryRoute({
    clock,
    read: async () => {
      calls += 1;
      if (calls === 1) return new Promise<string>((resolve) => { release = resolve; });
      return "1\nacme/two\n";
    },
  });
  const first = invoke(route);
  const second = invoke(route);
  assert.equal(calls, 1);
  assert.ok(release);
  release("1\nacme/one\n");
  assert.deepEqual((await first).body, (await second).body);
  now += 60_000;
  assert.deepEqual((await invoke(route)).body.repositories, ["acme/two"]);
  assert.equal(calls, 2);
});

test("the default inventory reader really shells out through the bounded gh transport", async (t) => {
  const shim = ghShim([{ when: "installation/repositories", stdout: "1\nacme/real\n" }]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const result = await readOnboardingRepositoryInventory();
  assert.equal(result.state, "verified");
  assert.deepEqual(result.state === "verified" ? result.repositories : [], ["acme/real"]);
  assert.match(shim.calls()[0] ?? "", /--paginate --jq/);
});
