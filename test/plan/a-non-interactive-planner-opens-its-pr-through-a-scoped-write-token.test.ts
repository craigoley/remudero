import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import * as boundary from "#src/lib/secret-boundary.js";
import { mintScopedToken, type ScopedTokenResult } from "#src/lib/github-app.js";
import { openPrMintTexts, planCommand, runGhPrCreate } from "#src/run-task.js";
import { buildWorkerEnv } from "#src/lib/env.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TOKEN = "ghs_fake_t11864_write_only";
const identity = { appId: "11", installationId: "22", keyPath: "/fixture/key.pem" };
const app = { kind: "app" as const, registryPath: "/fixture/registry.yaml", ...identity };
const permissions = { contents: "write", pull_requests: "write" };
const grant = { ok: true, token: TOKEN, permissions, repositories: ["remudero"] };
const savedToken = process.env.GH_TOKEN;
before(() => { delete process.env.GH_TOKEN; });
after(() => { if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken; });
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;

function assertNoCredentials(env: NodeJS.ProcessEnv): void {
  assert.deepEqual(Object.keys(env).filter((key) => key === "GH_TOKEN" || key.startsWith("GH_APP_")), []);
}

describe("test/plan/a-non-interactive-planner-opens-its-pr-through-a-scoped-write-token.test.ts", () => {
test("the write-token helper validates GitHub's granted permissions and repository names", async (t) => {
  assert.equal(typeof boundary.plannerPrWriteToken, "function");
  for (const [name, scope, missing] of [
    ["write grant", grant, []],
    ["pull_requests read", { ...grant, permissions: { ...permissions, pull_requests: "read" } }, ["pull_requests"]],
    ["pull_requests absent", { ...grant, permissions: { contents: "write" } }, ["pull_requests"]],
    ["contents read", { ...grant, permissions: { ...permissions, contents: "read" } }, ["contents"]],
    ["repositories wider", { ...grant, repositories: ["remudero", "other"] }, ["repositories"]],
    ["repositories absent", { ...grant, repositories: undefined }, ["repositories"]],
    ["wrong repository", { ...grant, repositories: ["other"] }, ["repositories"]],
    ["permissions absent", { ...grant, permissions: undefined }, ["contents", "pull_requests"]],
    ["missing token", { ...grant, token: undefined }, ["token"]],
  ] satisfies Array<[string, ScopedTokenResult, string[]]>) {
    await t.test(name, async () => {
      const result = await boundary.plannerPrWriteToken(identity, "acme/remudero", { mint: async (_repo, _ttl, opts) => {
        assert.deepEqual(opts?.env, boundary.hostAppIdentityEnv(identity));
        assert.equal(_repo, "acme/remudero");
        assertNoCredentials(process.env);
        return mintScopedToken(_repo, _ttl, { ...opts, readKey: () => privateKey,
          fetchImpl: async () => new Response(JSON.stringify({ token: scope.token,
            expires_at: new Date(Date.now() + 60_000).toISOString(), permissions: scope.permissions,
            repositories: scope.repositories?.map((name) => ({ name })) }), { status: 201 }) });
      } });
      if (missing.length === 0) assert.deepEqual(result, { ok: true, token: TOKEN });
      else {
        assert.equal(result.ok, false);
        if (!result.ok) assert.deepEqual(result.missing, missing);
        assert.ok(!JSON.stringify(result).includes(TOKEN));
      }
    });
  }
  const minted = await boundary.plannerPrWriteToken(identity, "acme/remudero", { mint: (repo, ttl, opts) =>
    mintScopedToken(repo, ttl, { ...opts, readKey: () => privateKey, fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { repositories: ["remudero"], permissions });
      return new Response(JSON.stringify({ token: TOKEN, expires_at: new Date(Date.now() + 60_000).toISOString(),
        permissions, repositories: [{ name: "remudero" }] }), { status: 201 });
    } }) });
  assert.deepEqual(minted, { ok: true, token: TOKEN }, "the real mint echoes GitHub's granted scope");
  for (const mint of [async () => ({ ok: false, reason: TOKEN }), async () => { throw new Error(TOKEN); }]) {
    const result = await boundary.plannerPrWriteToken(identity, "acme/remudero", { mint });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});

test("W1-T11864 refusal path: insufficient scope stops planCommand before reservations, spawn and PR create", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t11864-refusal-"));
  const calls: string[] = [];
  try {
    const code = await planCommand(["--mode=create", "a fixture task"], {
      config: { root, installRoot: REPO_ROOT, claudeBin: "/bin/true" },
      plannerHostGitCredential: async () => app,
      prWriteToken: { mint: async () => ({
        ...grant, permissions: { contents: "write", pull_requests: "read" },
      }) },
      openPlannerGitCredential: async () => { calls.push("git credential"); throw new Error("must not open"); },
      spawn: async () => { calls.push("spawn"); throw new Error("must not spawn"); },
      prCreateExec: () => { calls.push("PR create"); throw new Error("must not create"); },
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(join(root, "repos")), false, "no clone or reservation push can run");
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.step === "plan.credential_refused" && row.boundary === "pr_create"
      && row.missing.includes("pull_requests")));
    assert.ok(!JSON.stringify(rows).includes(TOKEN));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the helper's default mint reads the key and keeps its App env private", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t11864-mint-"));
  try {
    const keyPath = join(dir, "key.pem");
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
    t.mock.method(globalThis, "fetch", async () => {
      assertNoCredentials(process.env);
      return new Response(JSON.stringify({ token: TOKEN, expires_at: new Date(Date.now() + 60_000).toISOString(),
        permissions, repositories: [{ name: "remudero" }] }), { status: 201 });
    });
    assert.deepEqual(await boundary.plannerPrWriteToken({ ...identity, keyPath }, "acme/remudero"), { ok: true, token: TOKEN });
    assertNoCredentials(process.env);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the PR-create executor and adoption GET have separate credential boundaries", () => {
  const command = { command: "gh" as const, args: ["api", "--method", "POST", "repos/acme/remudero/pulls"],
    options: { cwd: "/fixture", encoding: "utf8" as const } };
  const calls: string[] = [];
  const result = runGhPrCreate(command, "run-fixture", () => {}, () => {}, () => {
    calls.push("POST"); throw new Error("HTTP 422 Validation Failed");
  }, (_file, args, opts) => {
    calls.push("GET");
    assert.match(args[1], /pulls\?head=acme/);
    assert.equal(opts.env, undefined);
    assertNoCredentials(process.env);
    return JSON.stringify([{ html_url: "https://github.com/acme/remudero/pull/1", number: 1 }]);
  });
  assert.equal(result.prNumber, 1);
  assert.deepEqual(calls, ["POST", "GET"]);
});

test("planCommand mints afresh at POST only, keeps reads and worker env clear, and refuses a late mint failure", async (t) => {
  for (const mode of ["app", "adopt", "late refusal", "ambient"] as const) await t.test(mode, async (t) => withGhShim([
    { when: "pulls?state=open", stdout: "[]" }, { when: "pr list", stdout: "[]" },
    { when: "api --method POST", stdout: '{"html_url":"https://github.com/craigoley/remudero/pull/1","number":1}' },
    { when: "headRefName", stdout: '{"headRefName":"different-branch"}' },
  ], async (shim) => {
    const root = mkdtempSync(join(tmpdir(), "rmd-t11864-plan-"));
    const origin = gitRepo({ bare: true });
    const seed = gitRepo();
    const oldHooks = process.env.RMD_HARNESS_HOOKS_DIR;
    const said: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) => said.push(args.join(" ")));
    t.mock.method(console, "error", (...args: unknown[]) => said.push(args.join(" ")));
    let mints = 0, posts = 0, spawns = 0;
    try {
      assertNoCredentials(process.env);
      mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
      writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "- id: W1-T4\n  title: seed\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n");
      writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# Plan\n");
      seed.git("add", "-A"); seed.git("commit", "-m", "chore(plan): seed");
      seed.addRemote("origin", origin.dir); seed.git("push", "origin", "main");
      const repoDir = join(root, "repos", "remudero");
      mkdirSync(join(root, "repos"));
      execFileSync("git", ["clone", "--quiet", origin.dir, repoDir]);
      execFileSync("git", ["-C", repoDir, "config", "user.name", "fixture"]);
      execFileSync("git", ["-C", repoDir, "config", "user.email", "fixture@example.invalid"]);
      process.env.RMD_HARNESS_HOOKS_DIR = join(root, "fixture-hooks");
      mkdirSync(process.env.RMD_HARNESS_HOOKS_DIR);
      const code = await withLiveWritesAllowed(() => planCommand(["--mode=create", "a fixture task"], {
        config: { root, installRoot: REPO_ROOT, claudeBin: "/bin/true" },
        lintPlanForReviewFn: async () => ({ ran: true, label: "credential fixture", checked: 1, violations: [] }),
        plannerHostGitCredential: async (repo) => mode === "ambient"
          ? boundary.plannerHostGitCredential(repo, { registryPath: join(root, "absent.yaml") }) : app,
        openPlannerGitCredential: async () => ({ ok: true, lane: { wire: () => undefined, retire: () => {}, close: async () => {} } }),
        prWriteToken: { mint: async () => {
          assertNoCredentials(process.env);
          mints++;
          return mode === "late refusal" && mints === 2
            ? { ...grant, permissions: { ...permissions, pull_requests: "read" } }
            : { ...grant, token: mints === 1 ? "discarded-preflight-token" : TOKEN };
        } },
        spawn: async (args) => {
          spawns++;
          assertNoCredentials(process.env);
          assertNoCredentials(args.env ?? {});
          assertNoCredentials(buildWorkerEnv({}, process.env));
          assert.match(args.prompt, /W1-T5/);
          const id = "W1-T5";
          mkdirSync(join(args.cwd, "plan", "tasks.d"), { recursive: true });
          writeFileSync(join(args.cwd, "plan", "tasks.d", `${id}-fixture.yaml`),
            `- id: ${id}\n  title: fixture task\n  repo: remudero\n  origin: architect\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n  files: [test/fixture.test.ts]\n  acceptance:\n    - claim: fixture\n      proof: 'unit test: fixture'\n`);
          const text = `PROPOSED: file ${id} for the credential fixture`;
          return { text, blocks: [text], stderr: "", costUsd: 0, subtype: "success", isError: false,
            sessionId: "fixture", numTurns: 1, apiError: false, model: "claude-opus-5", effort: "high",
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, totalCostUsd: 0,
            billingMode: "subscription", verdict: "success", qualitySuspect: false,
            compactionEvents: [], childEnvKeys: [] } as never;
        },
        prCreateExec: mode === "ambient" ? undefined : (file, args, opts) => {
          if (args[2] !== "POST") {
            assert.equal(mode, "adopt");
            assert.match(args[1], /pulls\?head=/);
            assert.equal(opts.env, undefined);
            assertNoCredentials(process.env);
            return '[{"html_url":"https://github.com/craigoley/remudero/pull/1","number":1}]';
          }
          posts++;
          assert.equal(args[2], "POST");
          assert.equal(opts.env?.GH_TOKEN, TOKEN);
          assertNoCredentials(process.env);
          assert.ok(!Object.keys(opts.env ?? {}).some((key) => key.startsWith("GH_APP_")));
          if (mode === "adopt") throw new Error("HTTP 422 Validation Failed");
          return execFileSync(file, args, opts);
        },
      }));
      assert.equal(code, 1, "stop at the unrelated ownership guard or the late credential refusal");
      assert.equal(spawns, 1, said.join("\n"));
      assert.equal(posts, mode === "app" || mode === "adopt" ? 1 : 0);
      assert.equal(shim.calls().filter((call) => call.includes("api --method POST")).length,
        mode === "app" || mode === "ambient" ? 1 : 0);
      assert.equal(mints, mode === "ambient" ? 0 : 2);
      const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
      if (mode === "late refusal") assert.match(ledger, /plan.pr_write_credential_failed/);
      if (mode === "adopt") assert.match(ledger, /pr_create.adopted_existing/);
      assert.ok(shim.calls().some((call) => call.includes("pulls?state=open")), "open-PR reads retain the existing transport");
      assert.ok(!ledger.includes(TOKEN));
      assert.ok(!said.join("\n").includes(TOKEN));
      assert.ok(!ledger.includes("discarded-preflight-token"));
      assert.ok(!said.join("\n").includes("discarded-preflight-token"));
      assertNoCredentials(process.env);
      assert.equal(origin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/"), "refs/rmd-id/W1-T5",
        "finally releases unused ids and preserves the pushed filing under the existing release policy");
    } finally {
      if (oldHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
      else process.env.RMD_HARNESS_HOOKS_DIR = oldHooks;
      seed.cleanup(); origin.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }));
});

test("planner open-PR reads select the broker subprocess without a write credential", (t) => {
  const cache = mkdtempSync(join(tmpdir(), "rmd-t11864-broker-"));
  const oldCache = process.env.RMD_GH_CACHE_HOME;
  const dir = join(cache, "remudero", "gh-broker");
  let calls = 0;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "heartbeat"), "60\n");
    process.env.RMD_GH_CACHE_HOME = cache;
    const exec = ((file: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      calls++;
      assert.equal(file, process.execPath);
      assert.ok(args.includes(join(dir, "broker.sock")), "the transport selects the broker client");
      assert.ok(args.some((arg) => arg.includes("repos/acme/remudero/pulls?state=open")));
      assertNoCredentials(opts.env ?? process.env);
      assert.ok(!JSON.stringify(args).includes(TOKEN));
      return '[{"title":"broker fixture"}]';
    }) as typeof childProcess.execFileSync;
    t.mock.method(childProcess, "execFileSync", exec);
    syncBuiltinESMExports();
    assert.deepEqual(openPrMintTexts("acme", "remudero"), ["broker fixture\n\n"]);
    assert.equal(calls, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (oldCache === undefined) delete process.env.RMD_GH_CACHE_HOME;
    else process.env.RMD_GH_CACHE_HOME = oldCache;
    rmSync(cache, { recursive: true, force: true });
  }
});
});
