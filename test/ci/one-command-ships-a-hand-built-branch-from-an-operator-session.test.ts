import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
// @ts-expect-error The installed author entrypoint has no declaration file.
import { authorPushEligibility, failingTestsFromTap, pinnedNodeReexec, testSummary } from "#scripts/preflight-author.mjs";
import { handShipEffects, runHandShip, type HandShipEffects, type ShipReceipt } from "#src/lib/hand-ship.js";
import { configureGithubInstallationBudget } from "#src/lib/github-transport.js";
import type { InstallationBudget } from "#src/lib/github-installation-budget.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { HANDLERS } from "#test/helpers/run-task-test.js";

const head = "1".repeat(40);
const main = "2".repeat(40);
const branch = "run-unfiled-123";
const file = "test/ci/example.test.ts";
// The design's host entry: a name, an SSH target or "local", and a kind. A checkout is optional.
const mac = { name: "mac", target: "mac.example", kind: "mac" };
const linux = { name: "azure", target: "local", kind: "linux" } as const;

function receipt(): ShipReceipt {
  return {
    headSha: head, baseSha: main, verdict: "passed",
    steps: ["census-precheck", "static-preflight", "affected-tests"].map((name) => ({ name, ok: true })),
  };
}

function redReceipt(titles: string[]): ShipReceipt {
  const result = receipt();
  result.verdict = "failed";
  result.steps[2] = {
    name: "affected-tests", ok: false, judge: { given: 1, reported: 1 },
    diagnostics: { mayBeIncomplete: false }, testSummary: { pass: 1, fail: titles.length, cancelled: 0 },
  };
  result.failureAttribution = { counts: { failingAtHead: titles.length, unattributed: 0 },
    tests: titles.map((title, index) => ({ file, title, location: `${index + 1}:1` })) };
  return result;
}

function rerunResults(titles: string[]): { file: string; title: string; location: string; failed: boolean }[] {
  return titles.map((title, index) => ({ file, title, location: `${index + 1}:1`, failed: true }));
}

function passingResults(titles: string[]): { file: string; title: string; location: null; failed: boolean }[] {
  return titles.map((title) => ({ file, title, location: null, failed: false }));
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-hand-ship-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const body = join(root, "body.md");
  writeFileSync(body, "Acceptance:\n- Example | grep: example in example.ts\n");
  writeFileSync(join(root, "hand-ship-hosts.json"), JSON.stringify([mac, linux]));
  const options = { stateDir: root, cwd: root, write: (line: string) => lines.push(line) };
  const args = ["--title", "fix(example): ship the change", "--body-file", body];
  const lines: string[] = [];
  const calls: string[] = [];
  const workspace: Awaited<ReturnType<HandShipEffects["prepare"]>> = {
    preflight: async (priority) => { calls.push(`priority ${priority}`); return receipt(); },
    rerun: async (tree, target) => { calls.push(`${tree} ${target}`); return []; },
    close: async () => { calls.push("close"); },
  };
  const effects: HandShipEffects = {
    readHost: async (host) => host.kind === "mac" ? "1\n" : "MemAvailable: 2048000 kB\n",
    readSource: async () => ({ root, branch, head, origin: "https://github.com/example/repo.git" }),
    prepare: async (host) => { calls.push(`prepare ${host.name}`); return workspace; },
    push: async (source) => { calls.push(`push ${source.head}`); },
    findPull: async () => undefined,
    publish: async () => { calls.push("publish"); return { url: "https://example.com/pull/1", body: readFileSync(body, "utf8") }; },
    checkBody: (stored) => { assert.equal(stored, readFileSync(body, "utf8")); calls.push("check stored body"); },
  };
  return { root, body, options, args, calls, lines, effects, workspace };
}

test("W1-T12169 criterion 1 chooses a measured normal Mac and skips unreadable hosts", async (t) => {
  const f = fixture(t);
  assert.equal(await runHandShip(f.args, f.options, f.effects), 0);
  assert.match(f.lines.join("\n"), /mac.*normal.*1/);
  f.effects.readHost = async (host) => {
    if (host.kind === "mac") throw new Error("SSH reading timed out");
    return "MemAvailable: 2048000 kB\n";
  };
  assert.equal(await runHandShip(f.args, f.options, f.effects), 0);
  assert.match(f.lines.join("\n"), /mac: reading unavailable.*timed out/);
  assert.match(f.lines.join("\n"), /azure.*2048000 kB/);
  f.effects.readHost = async () => "broken";
  const preparations = f.calls.filter((call) => call.startsWith("prepare"));
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.deepEqual(f.calls.filter((call) => call.startsWith("prepare")), preparations);
});

test("W1-T12169 criterion 2 asks the Mac launcher for low priority", async (t) => {
  const f = fixture(t);
  assert.equal(await runHandShip(f.args, f.options, f.effects), 0);
  assert.ok(f.calls.includes("priority low"));
  f.effects.readHost = async (host) => host.kind === "mac" ? "2" : "MemAvailable: 2048000 kB\n";
  assert.equal(await runHandShip(f.args, f.options, f.effects), 0);
  assert.ok(f.calls.includes("priority normal"));
});

test("W1-T12169 criterion 3 compares isolated head failures with unchanged main on the same host", async (t) => {
  const f = fixture(t);
  f.workspace.preflight = async () => redReceipt(["flake", "existing red", "regression"]);
  f.workspace.rerun = async (tree, target, sha, title) => {
    f.calls.push(`${tree} ${target} ${sha} ${title ?? ""}`);
    if (title === "flake" && tree === "head") return passingResults(["flake"]);
    if (title === "existing red") return [{ file, title, location: "2:1", failed: true }];
    if (title === "regression" && tree === "head") return [{ file, title, location: "3:1", failed: true }];
    return [];
  };
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.deepEqual(f.calls, [`prepare mac`, `head ${file} ${head} flake`,
    `head ${file} ${head} existing red`, `head ${file} ${head} regression`,
    `main ${file} ${main} flake`, `main ${file} ${main} existing red`, `main ${file} ${main} regression`, "close"]);
  assert.match(f.lines.join("\n"), /caused by the host.*flake/);
  assert.match(f.lines.join("\n"), /also failing on main.*existing red/);
  assert.match(f.lines.join("\n"), /caused by the change.*regression/);
});

test("an exact named test that reruns green is classified as host-caused", async (t) => {
  const f = fixture(t);
  f.workspace.preflight = async () => redReceipt(["original failure"]);
  f.workspace.rerun = async (tree) => tree === "head" ? passingResults(["original failure"]) : [];
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.match(f.lines.join("\n"), /caused by the host.*original failure/);
});

test("workflow contract failures are isolated on head and unchanged main before the run is refused", async (t) => {
  const f = fixture(t);
  f.workspace.preflight = async () => ({
    ...receipt(), verdict: "failed",
    steps: [{ name: "census-precheck", ok: true }, { name: "workflow-contract-precheck", ok: false,
      suites: [file], diagnostics: { mayBeIncomplete: false }, testSummary: { pass: 1, fail: 1, cancelled: 0 } }],
  });
  f.workspace.rerun = async (tree, target, _sha, title) => {
    f.calls.push(`${tree} ${target} ${title ?? ""}`);
    return tree === "head" ? rerunResults(["head contract failure"]) : rerunResults(["main contract failure"]);
  };
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.match(f.lines.join("\n"), /caused by the change.*head contract failure/);
  assert.deepEqual(f.calls.filter((call) => /^(head|main) /.test(call)),
    [`head ${file} `, `head ${file} head contract failure`, `main ${file} head contract failure`]);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});

test("W1-T12169 criterion 4 gives the installed receipt judge complete comparisons before push", async (t) => {
  const f = fixture(t);
  const original = redReceipt(["existing one", "existing two"]);
  assert.equal(authorPushEligibility(original).pushEligible, false);
  f.workspace.preflight = async () => original;
  f.workspace.rerun = async () => rerunResults(["existing one", "existing two"]);
  assert.equal(await runHandShip(f.args, f.options, f.effects), 0);
  assert.match(f.lines.join("\n"), /also failing on main.*existing one/);
  assert.match(f.lines.join("\n"), /also failing on main.*existing two/);
  assert.deepEqual(f.calls.slice(-3), [`push ${head}`, "publish", "check stored body"]);

  f.calls.length = 0;
  f.workspace.rerun = async (tree) => rerunResults(tree === "head" ? ["existing one", "existing two"] : ["existing one"]);
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));

  const staticRed = receipt();
  staticRed.verdict = "failed";
  staticRed.steps[1] = { name: "static-preflight", ok: false, failedCheck: "typecheck" };
  f.workspace.preflight = async () => staticRed;
  f.workspace.rerun = async () => assert.fail("static failures must not run tests again");
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.match(f.lines.join("\n"), /caused by the change.*typecheck/);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});

test("W1-T12169 criterion 5 stops the active run by its id and lets the next queued run proceed", async (t) => {
  const f = fixture(t);
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  let launches = 0;
  f.effects.prepare = async (_host, _source, { signal }) => ({
    ...f.workspace,
    preflight: async () => {
      if (++launches === 1) {
        started();
        signal.addEventListener("abort", resolveStopped, { once: true });
        await stopped;
        signal.throwIfAborted();
      }
      return receipt();
    },
  });
  const first = runHandShip(f.args, f.options, f.effects);
  await entered;
  const state = join(f.root, "hand-ship");
  const id = readdirSync(state).find((name) => /^rmd-ship-/.test(name))!;
  const second = runHandShip(f.args, f.options, f.effects);
  await delay(50);
  assert.equal(launches, 1);
  assert.equal(await runHandShip(["stop", "../invalid"], f.options, f.effects), 2);
  assert.equal(await runHandShip(["stop", id], f.options, f.effects), 0);
  assert.equal(await first, 1);
  assert.equal(await second, 0);
  assert.equal(await runHandShip(["stop", id], f.options, f.effects), 1);
  assert.equal(JSON.parse(readFileSync(join(state, id, "status.json"), "utf8")).status, "stopped");
  assert.equal(launches, 2);
  assert.equal(f.calls.filter((call) => call === `push ${head}`).length, 1);
});

test("the registered command handles bad usage before configuration and refuses unknown runs or malformed hosts", async (t) => {
  const f = fixture(t);
  const handler = HANDLERS.get("hand-worktree")!;
  assert.equal(await handler(["ship", "--unexpected"]), 2);
  assert.equal(await handler(["--unexpected"]), 2);
  assert.equal(await runHandShip([], f.options, f.effects), 2);
  assert.equal(await runHandShip(["stop", "rmd-ship-1234567890123-abcdef"], f.options, f.effects), 1);
  writeFileSync(join(f.root, "hand-ship-hosts.json"), JSON.stringify([{ ...mac, target: "-oInvalid" }]));
  await assert.rejects(runHandShip(f.args, f.options, f.effects), /expected hosts with name, target/);
});

test("a partial failing-test list cannot be turned into eligible evidence", async (t) => {
  const f = fixture(t);
  const partial = redReceipt(["one red", "unnamed red"]);
  partial.failureAttribution!.tests!.pop();
  f.workspace.preflight = async () => partial;
  f.workspace.rerun = async () => assert.fail("there is no complete list of failing tests to rerun");
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.match(f.lines.join("\n"), /did not completely name its failures/);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});

test("an amendment reuses the open PR and requires its own acceptance block before pushing", async (t) => {
  const f = fixture(t);
  f.effects.findPull = async () => 42;
  f.effects.publish = async (_source, _title, body, existing) => {
    assert.equal(existing, 42);
    return { url: "https://example.com/pull/42", body };
  };
  assert.equal(await runHandShip(f.args, f.options, f.effects), 0);
  writeFileSync(f.body, "An amendment without an acceptance block.\n");
  f.calls.length = 0;
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.match(f.lines.join("\n"), /amendment pull request requires a valid Acceptance:/);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});

test("one occurrence on main accounts for only one same-location duplicate failure", async (t) => {
  const f = fixture(t);
  const original = redReceipt(["duplicate", "duplicate"]);
  original.failureAttribution!.tests!.forEach((test) => { test.location = "7:3"; });
  f.workspace.preflight = async () => original;
  f.workspace.rerun = async (tree) => (tree === "head" ? ["duplicate", "duplicate"] : ["duplicate"])
    .map((title) => ({ file, title, location: "7:3", failed: true }));
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1, f.lines.join("\n"));
  assert.match(f.lines.join("\n"), /also failing on main.*duplicate/);
  assert.match(f.lines.join("\n"), /caused by the change.*duplicate/);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});

test("a nested target comparison ignores sibling results from its selected parent", async (t) => {
  const f = fixture(t);
  const original = redReceipt(["parent > leaf"]);
  original.failureAttribution!.tests![0]!.location = "10:1";
  f.workspace.preflight = async () => original;
  f.workspace.rerun = async (tree) => [
    { file, title: "parent", location: "9:1", failed: true, suite: true },
    { file, title: "parent > leaf", location: "10:1", failed: true },
    { file, title: "parent > sibling", location: "11:1", failed: tree === "head" },
  ];
  assert.equal(await runHandShip(f.args, f.options, f.effects), 0, f.lines.join("\n"));
  assert.match(f.lines.join("\n"), /also failing on main.*parent > leaf/);
  assert.doesNotMatch(f.lines.join("\n"), /sibling/);
});

test("different same-title failures at distinct source locations never become base-red evidence", async (t) => {
  const f = fixture(t);
  const original = redReceipt(["duplicate", "duplicate"]);
  original.failureAttribution!.tests![0]!.location = "10:1";
  original.failureAttribution!.tests![1]!.location = "20:1";
  f.workspace.preflight = async () => original;
  f.workspace.rerun = async (tree) => tree === "head"
    ? [{ file, title: "duplicate", location: "10:1", failed: true }, { file, title: "duplicate", location: "20:1", failed: true }]
    : [{ file, title: "duplicate", location: "25:1", failed: true }];
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.match(f.lines.join("\n"), /also failing on main.*duplicate/);
  assert.match(f.lines.join("\n"), /caused by the change.*duplicate/);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});

test("a failing test that only moved lines between main and head is also failing on main", async (t) => {
  const f = fixture(t);
  const original = redReceipt(["unchanged red"]);
  original.failureAttribution!.tests![0]!.location = "11:1";
  f.workspace.preflight = async () => original;
  f.workspace.rerun = async (tree) => [{ file, title: "unchanged red", location: tree === "head" ? "11:1" : "10:1", failed: true }];
  assert.equal(await runHandShip(f.args, f.options, f.effects), 0, f.lines.join("\n"));
  assert.match(f.lines.join("\n"), /also failing on main: test\/ci\/example\.test\.ts :: unchanged red/);
  assert.doesNotMatch(f.lines.join("\n"), /caused by the change/);
  assert.ok(f.calls.includes(`push ${head}`));
});

test("the production rerun selects one nested leaf and retains passing TAP rows without locations", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo, true);
  writeFileSync(join(repo.dir, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  writeFileSync(join(repo.dir, file), [
    'import { test } from "node:test";',
    'test("parent", async (context) => {',
    '  await context.test("leaf", () => { throw new Error("selected leaf"); });',
    '  await context.test("sibling", () => {});',
    '});',
    "",
  ].join("\n"));
  repo.git("add", file, "package-lock.json", "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "nested test fixture");
  const defaults = handShipEffects(() => 0);
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  const workspace = await defaults.prepare({ ...mac, target: "local", kind: "mac" as const, checkout: REPO_ROOT }, source, run);
  try {
    const rows = await workspace.rerun("head", file, source.head, "parent > leaf");
    assert.ok(rows.some((row) => row.title === "parent > leaf" && row.failed === true));
    assert.ok(rows.some((row) => row.title === "parent" && row.failed === true && row.suite === true));
    assert.ok(!rows.some((row) => row.title === "parent > sibling"), "the sibling must be skipped by the runner");
    const passingSibling = await workspace.rerun("head", file, source.head, "parent > sibling");
    assert.ok(passingSibling.some((row) => row.file === file && row.title === "parent > sibling" &&
      row.failed === false && row.location === null), `a locationless passing TAP row keeps its known input file: ${JSON.stringify(passingSibling)}`);
  } finally {
    await workspace.close();
  }
});

test("stopping during Git bundle creation aborts the Git operation", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const defaults = handShipEffects(() => 0);
  const controller = new AbortController();
  const run: Parameters<HandShipEffects["readSource"]>[1] & { git: typeof hostWorktreeGitAsync } = {
    dir: f.root, signal: controller.signal, log: f.options.write,
    async git(cwd, args, options) {
      if (args[0] === "bundle") {
        assert.equal(options?.signal, controller.signal);
        startBundle();
        return await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
        });
      }
      return hostWorktreeGitAsync(cwd, args, options);
    },
  };
  let startBundle!: () => void;
  const bundleStarted = new Promise<void>((resolve) => { startBundle = resolve; });
  const source = await defaults.readSource(repo.dir, run);
  const preparing = defaults.prepare({ ...mac, target: "local", kind: "mac" as const, checkout: REPO_ROOT }, source, run);
  await bundleStarted;
  controller.abort(new Error("stop requested"));
  await assert.rejects(preparing, /stop requested/);
});

test("workflow-contract failures use real isolated head and main reruns", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  const base = seedHandBranch(repo, true);
  writeFileSync(join(repo.dir, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  writeFileSync(join(repo.dir, file), [
    'import { test } from "node:test";',
    'test("workflow suite", async (context) => {',
    '  await context.test("contract failure", () => { throw new Error("contract changed"); });',
    '  await context.test("passing sibling", () => {});',
    '});',
    "",
  ].join("\n"));
  repo.git("add", file, "package-lock.json", "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "nested workflow contract fixture");
  f.options.cwd = repo.dir;
  const defaults = handShipEffects(() => 0);
  const effects: HandShipEffects = {
    ...defaults,
    readHost: async () => "1\n",
    prepare: async (host, shipSource, shipRun) => {
      const workspace = await defaults.prepare({ ...host, target: "local", kind: "mac" as const, checkout: REPO_ROOT }, shipSource, shipRun);
      workspace.preflight = async () => ({ headSha: shipSource.head, baseSha: base, verdict: "failed",
        steps: [{ name: "census-precheck", ok: true }, { name: "workflow-contract-precheck", ok: false,
          suites: [file], diagnostics: { mayBeIncomplete: false }, testSummary: { pass: 1, fail: 2, cancelled: 0 } }] });
      return workspace;
    },
    push: async () => { f.calls.push("push"); },
  };
  const result = await runHandShip(f.args, f.options, effects);
  assert.equal(result, 1);
  assert.match(f.lines.join("\n"), /caused by the change: test\/ci\/example\.test\.ts :: workflow suite > contract failure/);
  assert.doesNotMatch(f.lines.join("\n"), /passing sibling/);
  assert.ok(!f.calls.includes("push"));
});

test("a stop requested during PR publication leaves the run stopped", async (t) => {
  const f = fixture(t);
  let finishPublication!: () => void;
  const publication = new Promise<{ url: string; body: string }>((resolve) => {
    finishPublication = () => resolve({ url: "https://example.com/pull/1", body: readFileSync(f.body, "utf8") });
  });
  let publishStarted!: () => void;
  const started = new Promise<void>((resolve) => { publishStarted = resolve; });
  f.effects.publish = async () => { publishStarted(); return publication; };
  const first = runHandShip(f.args, f.options, f.effects);
  await started;
  const state = join(f.root, "hand-ship");
  const id = readdirSync(state).find((name) => /^rmd-ship-/.test(name))!;
  assert.equal(await runHandShip(["stop", id], f.options, f.effects), 0);
  finishPublication();
  assert.equal(await first, 1);
  assert.equal(JSON.parse(readFileSync(join(state, id, "status.json"), "utf8")).status, "stopped");
});

function seedHandBranch(repo: GitRepo, withTest = false): string {
  repo.addRemote("origin", "https://github.com/example/repo.git");
  writeFileSync(join(repo.dir, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"));
  writeFileSync(join(repo.dir, ".nvmrc"), readFileSync(join(REPO_ROOT, ".nvmrc"), "utf8"));
  writeFileSync(join(repo.dir, ".gitignore"), "node_modules\ncoverage/\n");
  mkdirSync(join(repo.dir, "node_modules"));
  if (withTest) {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), "");
    repo.git("add", file);
  }
  repo.git("add", "package-lock.json", ".gitignore", ".nvmrc");
  repo.git("commit", "-m", "base with dependency donor");
  const base = repo.git("rev-parse", "HEAD");
  repo.git("switch", "-c", branch);
  repo.git("commit", "--allow-empty", "-m", "hand branch");
  return base;
}

test("the local launcher reads Git, opens the committed bundle and cuts unchanged main", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  const base = seedHandBranch(repo);
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const defaults = handShipEffects(() => 0);
  const source = await defaults.readSource(repo.dir, run);
  assert.equal(source.branch, branch);
  assert.equal(source.head, repo.git("rev-parse", "HEAD"));
  if (process.platform === "linux") assert.match(await defaults.readHost(linux, run), /^MemAvailable:/m);
  const workspace = await defaults.prepare(linux, source, run);
  try {
    assert.ok(existsSync(join(f.root, "head.bundle")));
    assert.deepEqual(await workspace.rerun("main", file, base), []);
    await assert.rejects(workspace.rerun("head", file, base), /head changed before the isolated rerun/);
    await assert.rejects(workspace.rerun("head", file, source.head), /head test .* failed/);
  } finally {
    await workspace.close();
  }
  assert.equal(existsSync(join(f.root, "head.bundle")), false);
  assert.equal(repo.git("status", "--porcelain"), "");
  assert.equal(repo.git("branch", "--show-current"), branch);
});

test("the launcher passes the frozen head to preflight under nice and reads complete TAP from each checkout", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  const base = seedHandBranch(repo, true);
  writeFileSync(join(repo.dir, file), 'import { test } from "node:test"; test("existing red", () => { throw new Error("red"); });\n');
  repo.git("add", file);
  repo.git("commit", "-m", "name the test fixture");
  const defaults = handShipEffects(() => 0);
  const spawned: string[][] = [];
  let receiptBound = true;
  const run: Parameters<HandShipEffects["readSource"]>[1] = {
    dir: f.root, signal: new AbortController().signal, log: f.options.write,
    spawn(command, args, options) {
      if (command !== "/usr/bin/nice") return spawn(command, args, options);
      spawned.push(args);
      const cwd = String(options.cwd);
      if (args.includes("scripts/preflight-author.mjs")) {
        mkdirSync(join(cwd, "coverage"), { recursive: true });
        writeFileSync(join(cwd, "coverage/preflight-author.json"), JSON.stringify({ ...redReceipt(["existing red"]),
          headSha: repo.git("rev-parse", "HEAD"), baseSha: base, version: 1, dryRun: false,
          publicationIdentity: { state: "passed", headRef: receiptBound ? branch : "different-branch" } }));
        return spawn(process.execPath, ["-e", "process.stdout.write('preflight output'); process.exitCode = 1"], options);
      }
      const tap = `not ok 1 - existing red\n  ---\n  location: '${join(cwd, file)}:1:1'\n  ...\n` +
        "# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n";
      return spawn(process.execPath, ["-e", "process.stdout.write(process.argv[1]); process.exitCode = 1", tap], options);
    },
  };
  const source = await defaults.readSource(repo.dir, run);
  const workspace = await defaults.prepare({ ...linux, kind: "mac" }, source, run);
  try {
    const observed = await workspace.preflight("low");
    assert.equal(observed.headSha, source.head);
    assert.equal(observed.baseSha, base);
    const pin = readFileSync(join(repo.dir, ".nvmrc"), "utf8").trim();
    const pinned = process.versions.node === pin ? process.execPath
      : pinnedNodeReexec({ pin, current: process.versions.node, env: process.env }).reexec;
    assert.ok(pinned, "the .nvmrc Node is present on the local Mac");
    assert.deepEqual(spawned[0], ["-n", "10", pinned, "--import", "tsx", "scripts/preflight-author.mjs",
      "--head-ref", branch, "--head-sha", source.head]);
    assert.deepEqual(await workspace.rerun("head", file, source.head), [
      { file, title: "existing red", location: "1:1", fileLevel: false, failed: true },
    ]);
    assert.deepEqual(await workspace.rerun("head", file, source.head, "existing red"), [
      { file, title: "existing red", location: "1:1", fileLevel: false, failed: true },
    ]);
    assert.ok(spawned.at(-1)!.includes("--test-name-pattern"), "the isolated rerun selects the named failure");
    assert.deepEqual(await workspace.rerun("main", file, base), [
      { file, title: "existing red", location: "1:1", fileLevel: false, failed: true },
    ]);
    assert.ok(spawned.slice(1).every((args) => args.includes("--test-concurrency=1") && args.at(-1) === file));
    receiptBound = false;
    await assert.rejects(workspace.preflight("low"), /did not issue a receipt for this branch/);
    const log = join(f.root, "commands.log");
    assert.match(readFileSync(log, "utf8"), /not ok 1 - existing red/);
    rmSync(log);
    mkdirSync(log);
    await assert.rejects(workspace.preflight("low"), /EISDIR/);
  } finally {
    await workspace.close();
  }
});

test("the SSH launcher uploads the bundle and removes its private checkout after the comparison", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  const base = seedHandBranch(repo);
  const defaults = handShipEffects(() => 0);
  const calls: string[] = [];
  const run: Parameters<HandShipEffects["readSource"]>[1] = {
    dir: f.root, signal: new AbortController().signal, log: f.options.write,
    spawn(command, args, options) {
      if (command !== "ssh") return spawn(command, args, options);
      const remote = args.at(-1)!;
      calls.push(remote);
      return spawn("bash", ["-c", remote], options);
    },
  };
  const source = await defaults.readSource(repo.dir, run);
  const workspace = await defaults.prepare({ ...linux, target: "test-ssh", checkout: repo.dir, pathPrefix: "/operator/bin" }, source, run);
  try {
    assert.deepEqual(await workspace.rerun("main", file, base), []);
  } finally {
    await workspace.close();
  }
  assert.ok(calls.some((command) => command.includes("cat >") && command.includes("head.bundle")));
  assert.ok(calls.some((command) => command.includes('PATH="$1:$PATH"') && command.includes("/operator/bin")));
  const scratch = /\/tmp\/rmd-hand-ship\.[A-Za-z0-9]{8}/.exec(calls.at(-1)!)?.[0];
  assert.ok(scratch);
  assert.equal(existsSync(scratch), false);
  await assert.rejects(defaults.prepare(linux, { ...source, head: "0".repeat(40) }, run), /git checkout failed/);
  assert.equal(existsSync(join(f.root, "head.bundle")), false);
});

test("cancellation reaches both a local child and the SSH supervisor", async (t) => {
  const f = fixture(t);
  const defaults = handShipEffects(() => 0);
  for (const target of ["local", "test-ssh"]) {
    const controller = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const run: Parameters<HandShipEffects["readHost"]>[1] = {
      dir: f.root, signal: controller.signal, log: f.options.write,
      spawn(_command, args, options) {
        const child = target === "local" ? spawn("sleep", ["60"], options) : spawn("bash", ["-c",
          args.at(-1)!.replace("'cat' '/proc/meminfo'", "'sleep' '60'")], options);
        child.once("spawn", started);
        return child;
      },
    };
    const reading = defaults.readHost({ ...linux, target }, run);
    await running;
    controller.abort(new Error("cancelled reading"));
    await assert.rejects(reading, /cancelled reading/);
  }
  await assert.rejects(defaults.readHost(linux, {
    dir: f.root, signal: new AbortController().signal, log: f.options.write,
    spawn(_file, _args, options) { return spawn(join(f.root, "missing-binary"), [], options); },
  }), /ENOENT/);
  const exited = new AbortController();
  await assert.rejects(defaults.readHost(linux, {
    dir: f.root, signal: exited.signal, log: f.options.write,
    spawn(_file, _args, options) {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], options);
      child.once("exit", () => exited.abort(new Error("process ended during cancellation")));
      return child;
    },
  }), /process ended during cancellation/);
  await assert.rejects(defaults.readHost({ ...linux, target: "test-ssh" }, {
    dir: f.root, signal: new AbortController().signal, log: f.options.write,
    spawn(_file, _args, options) {
      const child = spawn("bash", ["-c", "read -r _"], options);
      child.once("spawn", () => child.stdin!.emit("error", Object.assign(new Error("SSH control pipe failed"), { code: "EIO" })));
      return child;
    },
  }), /SSH control pipe failed/);
});

/** A stand-in harness hook. By default it reports a measured Rule 15 pass, as the harness hook's rule15-precheck prints. */
function harnessGate(t: TestContext, script: string, rule15 = true, rule25 = rule15): string {
  const hooks = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-ship-hooks-`));
  const mark = join(hooks, "ran");
  const measured = (rule15 ? 'echo "rule15-precheck: OK -- no criterion field added or edited in the plan"\n' : "") +
    (rule25 ? 'echo "rule25-precheck: OK -- no instrument path rides with a src/ product path"\n' : "");
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\n${measured}${script.replaceAll("$MARK", mark)}\n`);
  chmodSync(join(hooks, "pre-push"), 0o755);
  const saved = { hooks: process.env.RMD_HARNESS_HOOKS_DIR, gates: process.env.RMD_PREPUSH_GATES };
  process.env.RMD_HARNESS_HOOKS_DIR = hooks;
  t.after(() => {
    if (saved.hooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR; else process.env.RMD_HARNESS_HOOKS_DIR = saved.hooks;
    if (saved.gates === undefined) delete process.env.RMD_PREPUSH_GATES; else process.env.RMD_PREPUSH_GATES = saved.gates;
    rmSync(hooks, { recursive: true, force: true });
  });
  return mark;
}

test("the source publisher sends one non-forced refspec pinned to the receipt head and refuses drift", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  repo.git("config", "--local", "core.hooksPath", "");
  const gate = harnessGate(t, 'cat > /dev/null; echo pass >> "$MARK"');
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  await withLiveWritesAllowed(() => defaults.push(source, run));
  assert.deepEqual(requests, [["push", "origin", `${source.head}:refs/heads/${branch}`]]);
  assert.equal(readFileSync(gate, "utf8"), "pass\n", "the harness gate runs even where the checkout disables hooks");
  repo.git("commit", "--allow-empty", "-m", "head moved after receipt");
  await assert.rejects(defaults.push(source, run), /changed during verification/);
  assert.equal(requests.length, 1);
});

test("an operator checkout with Git's default hooks still runs every pre-push check and has no opt-out", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const gate = harnessGate(t, '[ "${RMD_PREPUSH_GATES:-}" = "0" ] && exit 0\ncat > /dev/null; echo refused >> "$MARK"; exit 1');
  process.env.RMD_PREPUSH_GATES = "0";
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  await assert.rejects(withLiveWritesAllowed(() => defaults.push(source, run)));
  assert.equal(readFileSync(gate, "utf8"), "refused\n");
  assert.deepEqual(requests, [], "a refused check stops the push");
  rmSync(join(dirname(gate), "pre-push"));
  await assert.rejects(withLiveWritesAllowed(() => defaults.push(source, run)), /required pre-push gate .* is missing/);
  assert.deepEqual(requests, []);
});

test("the GitHub adapter creates or updates and then checks the freshly stored body", async (t) => {
  const f = fixture(t);
  const source = await f.effects.readSource(f.root, { dir: f.root, signal: new AbortController().signal, log: f.options.write });
  const body = readFileSync(f.body, "utf8");
  const pull = { number: 42, body, html_url: "https://github.com/example/repo/pull/42" };
  const calls: { args: string[]; fresh?: true }[] = [];
  const responses: unknown[] = [[], pull, pull, [pull], pull, pull];
  const defaults = handShipEffects((path) => {
    assert.equal(readFileSync(path, "utf8"), body);
    return 0;
  }, async (args, fresh) => {
    calls.push({ args, fresh });
    return responses.shift();
  });
  const controller = new AbortController();
  const run = { dir: f.root, signal: controller.signal, log: f.options.write };
  assert.equal(await defaults.findPull(source, run), undefined);
  assert.equal((await defaults.publish(source, "Title", body, undefined, run)).url, pull.html_url);
  assert.equal(await defaults.findPull(source, run), 42);
  const stored = await defaults.publish(source, "Title", body, 42, run);
  defaults.checkBody(stored.body, { dir: f.root, signal: new AbortController().signal, log: f.options.write });
  assert.match(calls[0].args[1], /head=example%3Arun-unfiled-123/);
  assert.deepEqual(calls[1].args.slice(0, 8), ["api", "-X", "POST", "repos/example/repo/pulls", "-f", `head=${branch}`, "-f", "base=main"]);
  assert.deepEqual(calls[4].args.slice(0, 4), ["api", "-X", "PATCH", "repos/example/repo/pulls/42"]);
  assert.deepEqual(calls[5], { args: ["api", "repos/example/repo/pulls/42"], fresh: true });
  responses.push([pull, pull]);
  await assert.rejects(defaults.findPull(source, run), /did not identify a unique pull request/);
});

test("a stop after the GitHub write prevents publication readback", async (t) => {
  const f = fixture(t);
  const source = await f.effects.readSource(f.root, { dir: f.root, signal: new AbortController().signal, log: f.options.write });
  const controller = new AbortController();
  let finishWrite!: () => void;
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => { writeStarted = resolve; });
  const write = new Promise<void>((resolve) => { finishWrite = resolve; });
  const calls: string[][] = [];
  const defaults = handShipEffects(() => 0, async (args) => {
    calls.push(args);
    writeStarted();
    await write;
    return { number: 42, body: readFileSync(f.body, "utf8"), html_url: "https://github.com/example/repo/pull/42" };
  });
  const run = { dir: f.root, signal: controller.signal, log: f.options.write };
  const publishing = defaults.publish(source, "Title", readFileSync(f.body, "utf8"), undefined, run);
  await started;
  controller.abort(new Error("stop requested"));
  finishWrite();
  await assert.rejects(publishing, /stop requested/);
  assert.equal(calls.length, 1, "no PR readback starts after cancellation");
});

/** An SSH client whose host has its own filesystem: the host's /tmp is `remote`/tmp, and paths it prints read as its own. */
function separateHost(remote: string) {
  const host = `const { spawn } = require("node:child_process");
const [root, command] = process.argv.slice(1);
const out = [];
const child = spawn("bash", ["-c", command.replaceAll("/tmp/rmd-hand-ship.", root + "/tmp/rmd-hand-ship.")], { stdio: ["inherit", "pipe", "inherit"] });
child.stdout.on("data", (chunk) => out.push(chunk));
child.on("close", (code) => { process.stdout.write(Buffer.concat(out).toString("utf8").replaceAll(root + "/tmp/", "/tmp/")); process.exitCode = code ?? 1; });`;
  return (command: string, args: string[], options: SpawnOptions) =>
    command === "ssh" ? spawn(process.execPath, ["-e", host, remote, args.at(-1)!], options) : spawn(command, args, options);
}

test("a named failure on a separate SSH host is isolated there and compared with main there", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo, true);
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  writeFileSync(join(repo.dir, file), [
    'import { test } from "node:test";',
    'test("parent", async (context) => {',
    '  await context.test("leaf", () => { throw new Error("remote leaf"); });',
    '  await context.test("sibling", () => {});',
    '});',
    "",
  ].join("\n"));
  repo.git("add", file, "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "remote test fixture");
  const remote = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-ship-remote-`)));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  mkdirSync(join(remote, "tmp"));
  const bin = join(remote, "bin");
  mkdirSync(bin);
  // The host has no configured checkout, so it installs the locked dependencies itself.
  writeFileSync(join(bin, "npm"), `#!/bin/sh\n[ "$1 $2" = "ci --no-audit" ] || exit 9\nln -s '${join(REPO_ROOT, "node_modules")}' node_modules\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const hosts = join(f.root, "hosts.json");
  writeFileSync(hosts, JSON.stringify([{ name: "azure", target: "azure.example", kind: "linux", pathPrefix: bin }]));
  const defaults = handShipEffects(() => 0);
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write, spawn: separateHost(remote) };
  const source = await defaults.readSource(repo.dir, run);
  const host = JSON.parse(readFileSync(hosts, "utf8"))[0];
  const workspace = await defaults.prepare(host, source, run);
  try {
    const scratch = readdirSync(join(remote, "tmp")).find((name) => name.startsWith("rmd-hand-ship."))!;
    assert.ok(scratch, "the scratch checkout is on the host");
    assert.equal(existsSync(join("/tmp", scratch)), false, "the operator's filesystem has no copy of the host's scratch path");
    const headRows = await workspace.rerun("head", file, source.head, "parent > leaf");
    assert.ok(headRows.some((row) => row.title === "parent > leaf" && row.failed === true), JSON.stringify(headRows));
    assert.ok(!headRows.some((row) => row.title === "parent > sibling"));
    const mainRows = await workspace.rerun("main", file, source.head, "parent > leaf");
    assert.ok(mainRows.some((row) => row.title === "parent > leaf" && row.failed === true), JSON.stringify(mainRows));
  } finally {
    await workspace.close();
  }
  assert.deepEqual(readdirSync(join(remote, "tmp")), [], "the host's private checkout is removed");
});

function liveProcess(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); }
  catch { return false; }
}

test("a stopped child is reported stopped only after every member of its process group is gone", async (t) => {
  const f = fixture(t);
  const defaults = handShipEffects(() => 0);
  const pidFile = join(f.root, "member.pid");
  const member = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const leader = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(member)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  const reading = defaults.readHost(linux, {
    dir: f.root, signal: controller.signal, log: f.options.write,
    spawn: (_file, _args, options) => spawn(process.execPath, ["-e", leader], options),
  });
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) await delay(20);
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  controller.abort(new Error("stop requested"));
  await assert.rejects(reading, /stop requested/);
  for (let i = 0; i < 50 && liveProcess(pid); i += 1) await delay(20);
  assert.equal(liveProcess(pid), false, "the SIGTERM-ignoring group member is killed before the stop is reported");
});

test("W1-T12169 criterion 3: a failing it inside a describe is isolated on head without counting its suite row as a test", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo, true);
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  writeFileSync(join(repo.dir, file), [
    'import { describe, it } from "node:test";',
    'describe("group", () => {',
    '  it("leaf", () => { throw new Error("described leaf"); });',
    '  it("sibling", () => {});',
    '});',
    "",
  ].join("\n"));
  repo.git("add", file, "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "describe test fixture");
  const defaults = handShipEffects(() => 0);
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  const workspace = await defaults.prepare({ ...mac, target: "local", kind: "mac" as const, checkout: REPO_ROOT }, source, run);
  try {
    const rows = await workspace.rerun("head", file, source.head, "group > leaf");
    assert.ok(rows.some((row) => row.title === "group > leaf" && row.failed === true && !row.suite), JSON.stringify(rows));
    assert.ok(rows.some((row) => row.title === "group" && row.failed === true && row.suite === true), JSON.stringify(rows));
    assert.ok(!rows.some((row) => row.title === "group > sibling"), "the sibling must be skipped by the runner");
    const mainRows = await workspace.rerun("main", file, source.head, "group > leaf");
    assert.ok(mainRows.some((row) => row.title === "group > leaf" && row.failed === true), JSON.stringify(mainRows));
  } finally {
    await workspace.close();
  }
});

test("W1-T12169 criterion 4: an update push is judged against the stored body its parent reads, and refused when it cannot be read", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  writeFileSync(join(repo.dir, "example.ts"), "body marker\n");
  repo.git("add", "example.ts");
  repo.git("commit", "-m", "the old tip carries the body proof's text");
  const oldTip = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "example.ts"), "reworded\n");
  repo.git("commit", "-am", "the pushed head rewords it");
  // The production open-PR body check, run as the harness hook runs it for an update of an existing branch.
  const precheck = [shellQuote(process.execPath), "--import", shellQuote(join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")),
    shellQuote(join(REPO_ROOT, "scripts/open-pr-body-proof-precheck.mjs")), "--head-ref", branch, "--old-sha", oldTip,
    '--new-sha "$sha"', '--remote-url "$2"'].join(" ");
  const gate = harnessGate(t, [
    'read -r _ sha _ _',
    `out=$(${precheck} 2>&1); rc=$?`,
    'printf "%s\\n" "$out" >> "$MARK"',
    'printf "%s\\n" "$out" >&2',
    '[ "$rc" -eq 2 ] && echo "pre-push: open-pr-body-proof-precheck could not read this push — not blocking on an unreadable check" >&2',
    '[ "$rc" -eq 1 ] && exit 1',
    "exit 0",
  ].join("\n"));
  // No network: the hook's own GitHub read fails, as it does with no credential, and the cached body is used.
  await withGhShim([{ when: "api", stderr: "To get started with GitHub CLI, please run:  gh auth login", exit: 4 }], async () => {
    const requests: string[][] = [];
    const reads: string[][] = [];
    let stored: string | Error | { number: number; body: string }[] = "Acceptance:\n- Ignored files | grep: node_modules in .gitignore\n";
    const defaults = handShipEffects(() => 0, async (args) => {
      reads.push(args);
      if (stored instanceof Error) throw stored;
      return Array.isArray(stored) ? stored : [{ number: 7, body: stored }];
    }, async (_cwd, args) => { requests.push([...args]); return ""; });
    const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
    const source = await defaults.readSource(repo.dir, run);
    const checks = () => readFileSync(gate, "utf8");

    await withLiveWritesAllowed(() => defaults.push(source, run));
    assert.match(checks(), /OK -- 1 body proofs \(cached body\)/, "the check judged the body the parent read");
    assert.equal(requests.length, 1, "a body proof that still holds lets the push go");
    assert.deepEqual(reads.at(-1), ["api", `repos/example/repo/pulls?state=open&head=example%3A${branch}`]);

    stored = "Acceptance:\n- Marker | grep: body marker in example.ts\n";
    await assert.rejects(withLiveWritesAllowed(() => defaults.push(source, run)), /newly falsifies a proof in the open PR's stored body/);
    assert.match(checks(), /NEWLY FALSIFIES 1 proof/);
    assert.equal(requests.length, 1, "a newly falsified body proof stops the push");

    const before = checks();
    stored = new Error("GitHub unreachable");
    await assert.rejects(withLiveWritesAllowed(() => defaults.push(source, run)), /stored body could not be read before the push \(GitHub unreachable\)/);
    assert.equal(checks(), before, "an unread body refuses the push before the gate runs");
    assert.equal(requests.length, 1);

    stored = [{ number: 7, body: "" }, { number: 8, body: "" }];
    await assert.rejects(withLiveWritesAllowed(() => defaults.push(source, run)), /GitHub did not name at most one open PR/);
    assert.equal(checks(), before, "an ambiguous answer refuses the push before the gate runs");
    assert.equal(requests.length, 1);
  });
});

test("W1-T12169 criterion 4: a required pre-push gate's hook gets no GitHub token or gh login", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const gate = harnessGate(t, 'cat > /dev/null; env > "$MARK"');
  const saved = { token: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN, config: process.env.GH_CONFIG_DIR };
  process.env.GH_TOKEN = "hand-ship-test-token";
  process.env.GITHUB_TOKEN = "hand-ship-test-token";
  process.env.GH_CONFIG_DIR = f.root;
  t.after(() => {
    for (const [key, value] of [["GH_TOKEN", saved.token], ["GITHUB_TOKEN", saved.github], ["GH_CONFIG_DIR", saved.config]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  await withLiveWritesAllowed(() => defaults.push(source, run));
  const env = readFileSync(gate, "utf8");
  assert.match(env, /^HOME=/m, "the hook ran and recorded its environment");
  assert.doesNotMatch(env, /^(GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR)=/m);
  assert.doesNotMatch(env, /hand-ship-test-token/);
  assert.equal(requests.length, 1);
});

test("W1-T12169 criterion 5: a stop during the pre-push gate settles only after the hook's whole process group is gone", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const pidFile = join(f.root, "hook-member.pid");
  harnessGate(t, `cat > /dev/null; echo started >> "$MARK"; sh -c 'trap "" TERM; echo $$ > ${shellQuote(pidFile)}; exec sleep 60' & wait`);
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const controller = new AbortController();
  const run = { dir: f.root, signal: controller.signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  const pushing = withLiveWritesAllowed(() => defaults.push(source, run));
  pushing.catch(() => {});
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) await delay(20);
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  controller.abort(new Error("stop requested"));
  await assert.rejects(pushing, /stop requested/);
  assert.equal(liveProcess(pid), false, "the hook's SIGTERM-ignoring child is gone before the stop is reported");
  assert.deepEqual(requests, [], "a stopped gate never pushes");
});

async function noOpenPull(): Promise<unknown> { return []; }

function shellQuote(word: string): string { return "'" + word.replaceAll("'", "'\\''") + "'"; }

test("W1-T12169 criterion 5: a stoppable pre-push gate that cannot start or overflows its output refuses the push", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const mark = harnessGate(t, 'cat > /dev/null; head -c 67108865 /dev/zero; echo overflowed >> "$MARK"');
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  // The refusal writes the gate's output through; keep 64 MiB of it out of the TAP stream.
  const writes = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await assert.rejects(withLiveWritesAllowed(() => defaults.push(source, run)), /refused this push/);
  } finally {
    process.stdout.write = writes.out;
    process.stderr.write = writes.err;
  }
  assert.deepEqual(requests, [], "an overflowing gate stops the push");
  // A directory where the hook should be cannot be executed by any uid.
  rmSync(join(dirname(mark), "pre-push"));
  mkdirSync(join(dirname(mark), "pre-push"));
  await assert.rejects(withLiveWritesAllowed(() => defaults.push(source, run)), /refused this push \(spawn EACCES\)/);
  assert.deepEqual(requests, [], "a gate that cannot start stops the push");
});

test("W1-T12169 criterion 3: a nested test red on head and main is classified by its leaf, and its aggregate parent follows it", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo, true);
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  writeFileSync(join(repo.dir, file), [
    'import { test } from "node:test";',
    'test("parent", async (context) => {',
    '  await context.test("leaf", () => { throw new Error("red on both revisions"); });',
    '  await context.test("sibling", () => {});',
    '});',
    'test("other", () => {});',
    "",
  ].join("\n"));
  repo.git("add", file, "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "the nested red is already on main");
  const mainSha = repo.git("rev-parse", "HEAD");
  repo.git("commit", "--allow-empty", "-m", "the hand change");
  // The author receipt's own failure list, from real Node TAP: the leaf AND its aggregate parent.
  const tap = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs"), file],
    { cwd: repo.dir, encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT" && key !== "NODE_OPTIONS")) });
  const named = failingTestsFromTap(tap.stdout, realpathSync(repo.dir)) as { file: string; title: string }[];
  assert.deepEqual(named.map((test) => test.title).sort(), ["parent", "parent > leaf"], `${tap.stdout}\n${tap.stderr}`);
  const summary = testSummary(tap.stdout);
  const defaults = handShipEffects(() => 0);
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  const real = await defaults.prepare({ ...mac, target: "local", kind: "mac" as const, checkout: REPO_ROOT }, source, run);
  const reruns: string[] = [];
  f.effects.readSource = async () => source;
  f.effects.prepare = async () => ({
    preflight: async () => ({
      headSha: source.head, baseSha: mainSha, verdict: "failed",
      steps: [{ name: "census-precheck", ok: true }, { name: "static-preflight", ok: true }, {
        name: "affected-tests", ok: false, judge: { given: 1, reported: 1 }, diagnostics: { mayBeIncomplete: false },
        testSummary: { pass: summary.pass, fail: summary.fail, cancelled: summary.cancelled, tests: summary.tests },
      }],
      failureAttribution: { counts: { failingAtHead: named.length, unattributed: 0 }, tests: named },
    }),
    rerun: async (tree, target, sha, title, count) => { reruns.push(`${tree} ${title}`); return real.rerun(tree, target, sha, title, count); },
    close: () => real.close(),
  });
  assert.equal(await runHandShip(f.args, f.options, f.effects), 0, f.lines.join("\n"));
  const log = f.lines.join("\n");
  assert.doesNotMatch(log, /caused by the host/, "a parent rerun with its failing child filtered out is not evidence");
  assert.match(log, /also failing on main: test\/ci\/example\.test\.ts :: parent > leaf$/m);
  assert.match(log, /also failing on main: test\/ci\/example\.test\.ts :: parent$/m);
  assert.deepEqual(reruns, ["head parent > leaf", "main parent > leaf"], "the aggregate parent is never rerun on its own");
  assert.ok(f.calls.includes(`push ${source.head}`));
});

test("W1-T12169 criterion 4: a required pre-push gate refuses a push whose Rule 15 check was unreadable or not measured", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  const quiet = async (push: () => Promise<void>) => {
    const writes = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { await push(); } finally { process.stdout.write = writes.out; process.stderr.write = writes.err; }
  };
  // The harness hook's exact line for an unreadable Rule 15 diff: it exits 0 and does not block.
  harnessGate(t, 'cat > /dev/null; echo "pre-push: rule15-precheck could not read the diff — not blocking on an unreadable check" >&2; exit 0', false);
  await assert.rejects(quiet(() => withLiveWritesAllowed(() => defaults.push(source, run))), /Rule 15/);
  harnessGate(t, 'cat > /dev/null; echo "pre-push: scripts/rule15-precheck.mjs absent — skipped, NOT passed" >&2; exit 0', false);
  await assert.rejects(quiet(() => withLiveWritesAllowed(() => defaults.push(source, run))), /Rule 15/);
  harnessGate(t, "cat > /dev/null; exit 0", false);
  await assert.rejects(quiet(() => withLiveWritesAllowed(() => defaults.push(source, run))), /Rule 15/);
  assert.deepEqual(requests, [], "an unmeasured Rule 15 check never lets the push go");
  harnessGate(t, "cat > /dev/null; exit 0");
  await withLiveWritesAllowed(() => defaults.push(source, run));
  assert.equal(requests.length, 1, "a measured Rule 15 pass lets the push go");
});

test("W1-T12169 criterion 5: a stop during a Git call settles only after the Git child's whole process group is gone", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  const pidFile = join(f.root, "git-member.pid");
  const controller = new AbortController();
  const calling = hostWorktreeGitAsync(repo.dir,
    ["-c", `alias.hang=!trap '' TERM; echo $$ > ${shellQuote(pidFile)}; exec sleep 60`, "hang"], { signal: controller.signal });
  calling.catch(() => {});
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) await delay(20);
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  controller.abort(new Error("stop requested"));
  const stopped = await calling.then(() => undefined, (error: unknown) => error);
  assert.equal(liveProcess(pid), false, "the Git child's SIGTERM-ignoring member is gone before the stop is reported");
  assert.match(String((stopped as Error)?.message), /stop requested/);
});

test("W1-T12169 criterion 3: a failing test registered with a computed title is rerun by its literal title on head and main and classified", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo, true);
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  const cases = (red: string[]) => [
    'import { test } from "node:test";',
    `const red = new Set(${JSON.stringify(red)});`,
    'for (const name of ["alpha", "beta", "gamma"]) test(`case ${name}`, () => { if (red.has(name)) throw new Error(`red ${name}`); });',
    'test("other", () => {});',
    "",
  ].join("\n");
  writeFileSync(join(repo.dir, file), cases(["alpha"]));
  repo.git("add", file, "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "a computed-title test is already red on main");
  const mainSha = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, file), cases(["alpha", "beta"]));
  repo.git("commit", "-am", "the hand change turns another computed case red");
  const tap = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs"), file],
    { cwd: repo.dir, encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT" && key !== "NODE_OPTIONS")) });
  const named = failingTestsFromTap(tap.stdout, realpathSync(repo.dir)) as { file: string; title: string }[];
  assert.deepEqual(named.map((test) => test.title).sort(), ["case alpha", "case beta"], `${tap.stdout}\n${tap.stderr}`);
  const summary = testSummary(tap.stdout);
  const defaults = handShipEffects(() => 0);
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  const real = await defaults.prepare({ ...mac, target: "local", kind: "mac" as const, checkout: REPO_ROOT }, source, run);
  const reruns: string[] = [];
  f.effects.readSource = async () => source;
  f.effects.prepare = async () => ({
    preflight: async () => ({
      headSha: source.head, baseSha: mainSha, verdict: "failed",
      steps: [{ name: "census-precheck", ok: true }, { name: "static-preflight", ok: true }, {
        name: "affected-tests", ok: false, judge: { given: 1, reported: 1 }, diagnostics: { mayBeIncomplete: false },
        testSummary: { pass: summary.pass, fail: summary.fail, cancelled: summary.cancelled, tests: summary.tests },
      }],
      failureAttribution: { counts: { failingAtHead: named.length, unattributed: 0 }, tests: named },
    }),
    rerun: async (tree, target, sha, title, count) => { reruns.push(`${tree} ${title}`); return real.rerun(tree, target, sha, title, count); },
    close: () => real.close(),
  });
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1, f.lines.join("\n"));
  const log = f.lines.join("\n");
  assert.doesNotMatch(log, /could not isolate|comparison unavailable/, log);
  assert.match(log, /also failing on main: test\/ci\/example\.test\.ts :: case alpha$/m);
  assert.match(log, /caused by the change: test\/ci\/example\.test\.ts :: case beta$/m);
  assert.deepEqual(reruns.sort(), ["head case alpha", "head case beta", "main case alpha", "main case beta"]);
  assert.ok(!f.calls.some((call) => call.startsWith("push")), "a failure caused by the change never pushes");
});

test("W1-T12169 criterion 4: a required pre-push gate refuses a push whose Rule 25 check was unreadable or not measured", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  const quiet = async (push: () => Promise<void>) => {
    const writes = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { await push(); } finally { process.stdout.write = writes.out; process.stderr.write = writes.err; }
  };
  // A measured Rule 15 pass, then each of the harness hook's exact Rule 25 lines that exit 0 without measuring it.
  harnessGate(t, 'cat > /dev/null; echo "pre-push: rule25-precheck could not read the diff — not blocking on an unreadable check" >&2; exit 0', true, false);
  await assert.rejects(quiet(() => withLiveWritesAllowed(() => defaults.push(source, run))), /Rule 25/);
  harnessGate(t, 'cat > /dev/null; echo "pre-push: scripts/rule25-precheck.mjs absent — skipped, NOT passed" >&2; exit 0', true, false);
  await assert.rejects(quiet(() => withLiveWritesAllowed(() => defaults.push(source, run))), /Rule 25/);
  harnessGate(t, "cat > /dev/null; exit 0", true, false);
  await assert.rejects(quiet(() => withLiveWritesAllowed(() => defaults.push(source, run))), /Rule 25/);
  assert.deepEqual(requests, [], "an unmeasured Rule 25 check never lets the push go");
  // Rule 25 is advisory: its measured NOTICE is a result, reported by the review and not refused by it.
  harnessGate(t, 'cat > /dev/null; echo "rule25-precheck: NOTICE -- this diff changes a measurement INSTRUMENT and src/ PRODUCT code together." >&2; exit 0', true, false);
  await quiet(() => withLiveWritesAllowed(() => defaults.push(source, run)));
  assert.equal(requests.length, 1, "a measured Rule 25 result lets the push go");
});

test("W1-T12169 criterion 5: a stop while a GitHub read waits for admission settles the run at the stop", async (t) => {
  const f = fixture(t);
  let waits = 0;
  const reading = { remaining: 0, limit: 5000, reset: Math.floor(Date.now() / 1000) + 3600, resource: "core" };
  const refusing: InstallationBudget = {
    consumers: undefined, record() {}, admit: () => ({ ok: true }), noteRead() {}, noteThrottle() {},
    claimRead: () => { waits += 1; return { ok: false, waitUntil: reading.reset, reason: "share", reading, allowance: 0, reads: 0 }; },
    allowance: () => 0, takeThrottleRows: () => [], threadInput: () => undefined, readGapMs: () => 0,
    // A long wait for the first refusal; a second refusal stands down, so an unstoppable wait still ends offline.
    resetWaitMs: () => waits > 1 ? undefined : 10_000,
  };
  configureGithubInstallationBudget(refusing);
  t.after(() => configureGithubInstallationBudget(undefined));
  // The production GitHub adapter, so the read goes through the transport's own admission wait.
  f.effects.findPull = handShipEffects(() => 0).findPull;
  const first = runHandShip(f.args, f.options, f.effects);
  while (waits === 0) await delay(20);
  const state = join(f.root, "hand-ship");
  const id = readdirSync(state).find((name) => /^rmd-ship-/.test(name))!;
  assert.equal(await runHandShip(["stop", id], f.options, f.effects), 0);
  const settled = await Promise.race([first, delay(3_000, "still waiting")]);
  assert.equal(settled, 1, "the run settles at the stop, not when the budget's reset passes");
  assert.equal(waits, 1, "the stopped read never asks for admission again");
  assert.equal(JSON.parse(readFileSync(join(state, id, "status.json"), "utf8")).status, "stopped");
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});
