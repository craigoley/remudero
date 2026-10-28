import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parse, stringify } from "yaml";
import { prStateCommand, type PrStateDeps } from "#src/lib/pr-state.js";
import { openLedgerUnion, readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
const now = Date.parse("2026-10-28T10:00:00Z");
const stamp = (age = 1000) => new Date(now - age).toISOString();
const url = (n: number) => `https://github.com/acme/project/pull/${n}`;
function evidence(n: number, age = 1000, head = `head-${n}`): Row[] {
  const common = { ts: stamp(age), pr_number: n, head_sha: head };
  return [
    { ...common, step: "sweep.disposed", merge_state: "clean", disposition: "mergeable" },
    { ...common, step: "sweep.terminal_head.not_stuck", checks_state: "green", failing_checks: [] },
    { ...common, step: "review.posted", state: "success" },
    { ...common, step: "automerge.armed", outcome: "armed" },
  ];
}
function capture(stateDir: string, overrides: Partial<PrStateDeps> = {}) {
  const out: string[] = [], err: string[] = [];
  const calls: string[][] = [];
  const deps: PrStateDeps = {
    stateDir: () => stateDir, repository: () => ({ owner: "acme", repo: "project" }),
    now: () => now, policyPollIntervalMs: () => 60_000,
    readBroker: async (args) => { calls.push(args); return response([1, 2, 3, 4, 5, 99]); },
    write: (text) => out.push(text), error: (text) => err.push(text), ...overrides,
  };
  return { deps, out, err, calls };
}
function response(numbers: number[]) {
  return { data: { repository: Object.fromEntries(numbers.map(n => [`pr${n}`, {
    headRefOid: `github-${n}`, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED", autoMergeRequest: null, state: "OPEN",
    commits: { nodes: [{ commit: { statusCheckRollup: {
      state: "SUCCESS", contexts: { nodes: [], pageInfo: { hasNextPage: false } },
    } } }] },
  }])) } };
}
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(join(dir, name)).toString("base64")]));
}

describe("test/ledger/pr-state-answers-from-the-ledger-before-github.test.ts", () => {
  test("W1-T10370: a fresh ledger answer makes no broker call", async t => {
    const rows = evidence(1);
    const fixture = writeLedger(rows.slice(2), { scope: t, rotations: [
      { at: "2026-10-27T00:00:00.000Z", rows: [rows[0]] },
      { at: "2026-10-28T00:00:00.000Z", rows: [rows[1]], gz: true },
    ] });
    const before = snapshot(fixture.dir);
    let walks = 0;
    const c = capture(fixture.dir, { readLedger: (dir, opts) => { walks++; return openLedgerUnion(dir, opts); } });
    assert.equal(await prStateCommand(["1", "1", "--max-age", "2m"], c.deps), 0);
    assert.deepEqual(c.calls, []);
    assert.equal(walks, 1);
    assert.equal(c.out.length, 1);
    assert.match(c.out[0], /head_sha: "head-1"/);
    assert.match(c.out[0], /checks: .*"state":"green"/);
    assert.match(c.out[0], /terminal_state: "open"/);
    assert.deepEqual(snapshot(fixture.dir), before);
    assert.deepEqual(readLedgerUnionRecordsSync(fixture.dir, { refuseIncomplete: true }).rows, rows);
  });

  test("W1-T10370: stale PRs are revalidated by one batched broker query", async t => {
    const incomplete = evidence(3).filter(row => row.step !== "review.posted");
    const fixture = writeLedger([...evidence(1), ...evidence(2, 300_000), ...incomplete], { scope: t });
    const c = capture(fixture.dir);
    assert.equal(await prStateCommand(["1", "2", "3", "4", "--max-age", "2m"], c.deps), 0);
    assert.equal(c.calls.length, 1);
    const args = c.calls[0];
    assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
    const query = args[args.indexOf("-f") + 1];
    assert.doesNotMatch(query, /pr1:|mutation/);
    for (const n of [2, 3, 4]) assert.match(query, new RegExp(`pr${n}:pullRequest\\(number:${n}\\)`));
    assert.match(c.out[0], /"head-1"/);
    for (const output of c.out.slice(1)) {
      assert.match(output, /github-/);
      assert.match(output, /source=github.graphql/);
    }
  });

  test("W1-T10370: every field prints its as-of time and source", async t => {
    const rows = evidence(1);
    rows[2].ts = stamp(2000);
    const fixture = writeLedger(rows, { scope: t });
    const c = capture(fixture.dir);
    await prStateCommand(["1", "--max-age", "2m"], c.deps);
    for (const key of ["head_sha", "checks", "mergeability", "review_state", "auto_merge", "terminal_state"]) {
      const line = c.out[0].split("\n").find(value => value.trimStart().startsWith(`${key}:`));
      assert.ok(line, key);
      assert.match(line, /as_of=2026-10-28T09:59:5[89]\.000Z source=[a-z_.]+/);
    }
    assert.match(c.out[0], new RegExp(`review_state: "success" as_of=${stamp(2000)} source=review.posted`));
  });

  test("a failed revalidation retains the stale ledger answer and its error without retry", async t => {
    const fixture = writeLedger(evidence(1, 300_000), { scope: t });
    let calls = 0;
    const c = capture(fixture.dir, { readBroker: async () => { calls++; throw new Error("broker unavailable"); } });
    assert.equal(await prStateCommand(["1", "--max-age", "2m"], c.deps), 1);
    assert.equal(calls, 1);
    assert.match(c.out[0], /STALE.*broker unavailable/);
    assert.match(c.out[0], /"head-1".*source=automerge.armed/);
  });

  test("the default age follows recent full sweep passes, with policy cadence as fallback", async t => {
    for (const [passes, expectedCalls] of [[[], 1], [[
      { step: "sweep.pass", ts: stamp(400_000), enumerated: 1 },
      { step: "sweep.pass", ts: stamp(100_000), enumerated: 1 },
      { step: "sweep.pass", ts: stamp(1000), pr_number: 99 },
    ], 0]] as [Row[], number][]) {
      const fixture = writeLedger([...passes, ...evidence(1, 180_000)], { scope: t });
      const c = capture(fixture.dir);
      await prStateCommand(["1"], c.deps);
      assert.equal(c.calls.length, expectedCalls);
    }
    const fixture = writeLedger(evidence(1, 180_000), { scope: t });
    const c = capture(fixture.dir, { policyPollIntervalMs: () => 120_000 });
    await prStateCommand(["1"], c.deps);
    assert.equal(c.calls.length, 0);
  });

  test("new-head evidence cannot reuse checks, review or arm facts from an older head", async t => {
    const fixture = writeLedger([...evidence(1), {
      ts: stamp(0), step: "sweep.disposed", pr_number: 1, head_sha: "new-head", merge_state: "conflict",
    }, ...evidence(1, 2000, "older-out-of-order")], { scope: t });
    const c = capture(fixture.dir, { readBroker: async () => { throw new Error("offline"); } });
    await prStateCommand(["1", "--max-age", "2m"], c.deps);
    assert.match(c.out[0], /head_sha: "new-head"/);
    for (const key of ["checks", "review_state", "auto_merge"]) assert.match(c.out[0], new RegExp(`${key}: unknown as_of=unknown source=unknown`));
  });

  test("the default cadence reader honors an injected policy file", async t => {
    const fixture = writeLedger(evidence(1, 180_000), { scope: t });
    const policy = parse(readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8"));
    policy.pollIntervalMs.value = 120_000;
    const policyPath = join(fixture.dir, "policy.yaml");
    writeFileSync(policyPath, stringify(policy));
    const c = capture(fixture.dir, { policyPollIntervalMs: undefined, policyPath });
    assert.equal(await prStateCommand(["1"], c.deps), 0);
    assert.equal(c.calls.length, 0);
  });

  test("an arm-skipped receipt does not assert an unarmed PR, and URL terminal rows survive rotation", async t => {
    const rows = evidence(1).filter(row => row.step !== "automerge.armed");
    rows.push({ ts: stamp(0), step: "automerge.arm_skipped", pr_number: 1, head_sha: "head-1", outcome: "ledger-refused" });
    rows.push({ ts: stamp(0), step: "pr.terminal", pr_url: url(1), state: "merged" });
    const fixture = writeLedger([], { scope: t, rotations: [{ at: stamp(0), rows, gz: true }] });
    const c = capture(fixture.dir, { readBroker: async () => { throw new Error("offline"); } });
    await prStateCommand(["1", "--max-age", "2m"], c.deps);
    assert.match(c.out[0], /auto_merge: unknown/);
    assert.match(c.out[0], /terminal_state: "merged".*source=pr.terminal/);
  });

  test("malformed and unreadable ledger sources force revalidation and name the lost evidence", async t => {
    const fixture = writeLedger(evidence(1), { scope: t });
    fixture.append([{ ts: "invalid", step: "sweep.disposed", pr_number: 1 }]);
    writeFileSync(join(fixture.dir, "ledger.2026-10-27T00-00-00-000Z.ndjson.gz"), "corrupt gzip");
    const c = capture(fixture.dir, { readBroker: async () => { throw new Error("offline"); } });
    assert.equal(await prStateCommand(["1", "--max-age", "2m"], c.deps), 1);
    assert.match(c.out[0], /ledger.*(unread|invalid)/i);
    assert.match(c.out[0], /STALE/);
  });

  test("GraphQL partial, null and truncated answers preserve stale fields with a named error", async t => {
    const fixture = writeLedger(evidence(1, 300_000), { scope: t });
    for (const reply of [
      { errors: [{ message: "not authorized" }] },
      { data: { repository: { pr1: null } } },
      { data: { repository: { pr1: { headRefOid: "partial" } } } },
    ]) {
      const c = capture(fixture.dir, { readBroker: async () => reply });
      assert.equal(await prStateCommand(["1", "--max-age", "2m"], c.deps), 1);
      assert.match(c.out[0], /STALE/);
      assert.match(c.out[0], /head_sha: "head-1"/);
    }
  });

  test("GraphQL check rollup includes commit statuses, newest attempts and pending checks", async t => {
    const fixture = writeLedger([], { scope: t });
    const reply = response([1]);
    const rollup = reply.data.repository.pr1.commits.nodes[0].commit.statusCheckRollup;
    Object.assign(rollup, { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
      { __typename: "CheckRun", name: "retry", status: "COMPLETED", conclusion: "FAILURE", startedAt: stamp(3000) },
      { __typename: "CheckRun", name: "retry", status: "COMPLETED", conclusion: "SUCCESS", startedAt: stamp(1000) },
      { __typename: "StatusContext", context: "external", state: "ERROR", createdAt: stamp(1000) },
      { __typename: "StatusContext", context: "external", state: "SUCCESS", createdAt: stamp(5000) },
      { __typename: "CheckRun", name: "queued", status: "QUEUED", conclusion: null, startedAt: stamp(1000) },
      { __typename: "StatusContext", context: "remudero-review", state: "PENDING", createdAt: stamp(1000) },
      { __typename: "CheckRun", name: "shared", status: "COMPLETED", conclusion: "FAILURE", startedAt: stamp(2000),
        checkSuite: { workflowRun: { databaseId: 10, workflow: { databaseId: 11, name: "one" } } } },
      { __typename: "CheckRun", name: "shared", status: "COMPLETED", conclusion: "SUCCESS", startedAt: stamp(1000),
        checkSuite: { workflowRun: { databaseId: 20, workflow: { databaseId: 22, name: "two" } } } },
    ] } });
    const c = capture(fixture.dir, { readBroker: async () => reply });
    await prStateCommand(["1"], c.deps);
    assert.match(c.out[0], /checks: .*"state":"red","failing":\["external","shared"\]/);
    assert.match(c.out[0], /review_state: "pending"/);
    rollup.contexts.pageInfo.hasNextPage = true;
    assert.equal(await prStateCommand(["1"], c.deps), 1);
    assert.match(c.out[1], /STALE.*(truncat|incomplete)/);
  });

  test("bad arguments fail before opening the ledger or broker", async () => {
    for (const args of [[], ["0"], ["1.5"], ["-1"], ["1", "--max-age"], ["1", "--max-age", "no"], ["1", "--wat"], ["1", "--max-age", "2m", "--max-age", "3m"]]) {
      const c = capture("unused", { readLedger: () => { throw new Error("must not read"); } });
      assert.equal(await prStateCommand(args, c.deps), 2, args.join(" "));
      assert.equal(c.calls.length, 0);
      assert.match(c.err[0], /usage:/);
    }
  });

  test("ledger, policy and repository failures remain explicit when revalidation cannot complete", async () => {
    for (const overrides of [
      { stateDir: () => { throw new Error("ledger location unavailable"); } },
      { policyPollIntervalMs: () => { throw new Error("policy unavailable"); } },
      { repository: () => { throw new Error("repository unavailable"); } },
    ]) {
      const c = capture("unused", { readLedger: async function* () {}, readBroker: async () => { throw new Error("offline"); }, ...overrides });
      assert.equal(await prStateCommand(["1"], c.deps), 1);
      assert.match(c.out[0], /STALE.*unavailable/);
    }
  });

  test("the default direct transport really spawns and retains a failed read as stale", async t => {
    const fixture = writeLedger(evidence(1, 300_000), { scope: t });
    // Node is the fixture's gh executable: it rejects api as a missing module, without a network call.
    symlinkSync(process.execPath, join(fixture.dir, "gh"));
    const c = capture(fixture.dir, { readBroker: undefined, env: {
      ...process.env, PATH: fixture.dir, RMD_GH_CACHE_HOME: fixture.dir, NODE_V8_COVERAGE: "",
    } });
    assert.equal(await prStateCommand(["1", "--max-age", "2m"], c.deps), 1);
    assert.match(c.out[0], /STALE.*(Command failed|Cannot find module)/);
    assert.match(c.out[0], /head_sha: "head-1"/);
  });

  test("the CLI dispatches pr-state usage and help before any invocation ledger write", t => {
    const fixture = writeLedger([], { scope: t });
    const before = snapshot(fixture.dir);
    for (const [arg, code] of [["0", 2], ["--help", 0]] as const) {
      const result = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "src", "run-task.ts"), "pr-state", arg], {
        cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, HOME: fixture.dir, NODE_V8_COVERAGE: "" },
      });
      assert.equal(result.status, code, result.stderr);
      assert.match(result.stdout + result.stderr, /rmd pr-state <n\.\.\.>/);
      assert.deepEqual(snapshot(fixture.dir), before);
    }
  });

  test("a fresh CLI answer reads the configured core ledger without writing state or invoking credentials", t => {
    const fixture = writeLedger([], { scope: t });
    const root = join(fixture.dir, "workspace");
    const cliRows = evidence(1).map(row => ({ ...row, ts: new Date(Date.now() - 1000).toISOString() }));
    const state = writeLedger(cliRows, { dir: join(root, "state") });
    const configDir = join(fixture.dir, ".config", "remudero");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ root, claudeBin: process.execPath }));
    const before = snapshot(join(root, "state"));
    const result = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "src", "run-task.ts"), "pr-state", "1"], {
      cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, HOME: fixture.dir, NODE_V8_COVERAGE: "" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /head_sha: "head-1"/);
    assert.match(result.stdout, /source=review.posted/);
    assert.deepEqual(snapshot(join(root, "state")), before);
    assert.equal(readLedgerUnionRecordsSync(join(root, "state")).rows.length, evidence(1).length);
    assert.equal(readFileSync(state.path, "utf8").split("\n").filter(Boolean).length, evidence(1).length);
  });

  test("the real broker client sends a single agent revalidation and writes no ledger rows", async t => {
    const fixture = writeLedger(evidence(1, 300_000), { scope: t });
    const socket = join(fixture.dir, "broker.sock");
    writeFileSync(join(fixture.dir, "heartbeat"), "60");
    const requests: Row[] = [];
    const wireReply = { type: "result", stdout: JSON.stringify(response([1])), stderr: "", exitCode: 0, outcome: "upstream-200" };
    const server = createServer(connection => {
      let input = "";
      connection.on("data", chunk => {
        input += String(chunk);
        if (!input.includes("\n")) return;
        requests.push(JSON.parse(input.trim()));
        connection.end(JSON.stringify(wireReply) + "\n");
      });
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const before = readFileSync(fixture.path, "utf8");
    const c = capture(fixture.dir, { readBroker: undefined, env: { ...process.env, XDG_CACHE_HOME: undefined, RMD_GH_CACHE_HOME: join(fixture.dir, "cache") } });
    // The broker client resolves <cache>/remudero/gh-broker. Link only the owned fixture.
    mkdirSync(join(fixture.dir, "cache", "remudero"), { recursive: true });
    symlinkSync(fixture.dir, join(fixture.dir, "cache", "remudero", "gh-broker"));
    assert.equal(await prStateCommand(["1", "--max-age", "2m"], c.deps), 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].class, "agent");
    assert.equal(requests[0].fresh, true);
    assert.match(c.out[0], /source=github.graphql/);
    wireReply.stdout = "invalid JSON";
    assert.equal(await prStateCommand(["1", "--max-age", "2m"], c.deps), 1);
    assert.match(c.out[1], /STALE.*SyntaxError/);
    Object.assign(wireReply, { stdout: "", stderr: "rate limited", exitCode: 1 });
    assert.equal(await prStateCommand(["1", "--max-age", "2m"], c.deps), 1);
    assert.match(c.out[2], /STALE.*rate limited/);
    assert.equal(requests.length, 3);
    assert.equal(readFileSync(fixture.path, "utf8"), before);
  });
});
