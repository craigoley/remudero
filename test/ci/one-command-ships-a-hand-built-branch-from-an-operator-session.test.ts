import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
// @ts-expect-error The installed author entrypoint has no declaration file.
import { authorPushEligibility, failingTestsFromTap, pinnedNodeReexec, testSummary } from "#scripts/preflight-author.mjs";
import { handShipEffects, runHandShip, type HandShipEffects, type ShipReceipt } from "#src/lib/hand-ship.js";
import { configureGithubInstallationBudget } from "#src/lib/github-transport.js";
import { GhReadBroker, serveGhReadBroker, type GhUpstreamExec, type GhUpstreamResult } from "#src/lib/gh-read-broker.js";
import { ghBrokerDir } from "#src/lib/gh-read-broker-client.js";
import { MAX_UNIX_SOCKET_PATH_BYTES, shortPathWhenTooLong } from "#src/lib/short-path-root.js";
import type { InstallationBudget } from "#src/lib/github-installation-budget.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { HANDLERS, handShipStopRunId, installUnhandledRejectionGuard, main as cliMain } from "#test/helpers/run-task-test.js";
import { checkCliFreshness } from "#src/lib/self-sync.js";

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

function rerunResults(titles: string[]) {
  return titles.map((title, index) => ({ file, title, location: `${index + 1}:1`, declaration: title, failed: true }));
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
    if (title === "existing red") return [{ file, title, location: "2:1", declaration: title, failed: true }];
    if (title === "regression" && tree === "head") return [{ file, title, location: "3:1", declaration: title, failed: true }];
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
    .map((title) => ({ file, title, location: "7:3", declaration: title, failed: true }));
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
    { file, title: "parent > leaf", location: "10:1", declaration: "first registration", failed: true },
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
    ? [{ file, title: "duplicate", location: "10:1", declaration: "first registration", failed: true }, { file, title: "duplicate", location: "20:1", declaration: "second registration", failed: true }]
    : [{ file, title: "duplicate", location: "25:1", declaration: "different registration", failed: true }];
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.doesNotMatch(f.lines.join("\n"), /also failing on main.*duplicate/);
  assert.match(f.lines.join("\n"), /caused by the change.*duplicate/);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});

test("a failing test that only moved lines between main and head is also failing on main", async (t) => {
  const f = fixture(t);
  const original = redReceipt(["unchanged red"]);
  original.failureAttribution!.tests![0]!.location = "11:1";
  f.workspace.preflight = async () => original;
  f.workspace.rerun = async (tree) => [{ file, title: "unchanged red", location: tree === "head" ? "11:1" : "10:1", declaration: "same registration", failed: true }];
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
    '  const sibling = "sibling";',
    '  await context.test(sibling, () => { console.log("DYNAMIC SIBLING RAN"); });',
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
    assert.doesNotMatch(readFileSync(join(f.root, "commands.log"), "utf8"), /DYNAMIC SIBLING RAN/);
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
  seedHandBranch(repo, true);
  writeFileSync(join(repo.dir, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  repo.git("add", "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "both revisions have the test runner setup");
  const base = repo.git("rev-parse", "HEAD");
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
      { file, title: "existing red", location: "1:1", fileLevel: false, failed: true, declaration: undefined },
    ]);
    assert.ok(spawned.at(-1)!.includes("--test-name-pattern=^existing red$"), "the isolated rerun selects the named failure");
    assert.ok(spawned.at(-1)!.some((arg) => arg.startsWith("--test-skip-pattern=")), "and skips every test off its path");
    assert.ok(!spawned.at(-1)!.some((arg) => /expose-internals|node:internal/.test(decodeURIComponent(arg))), "with public runner flags only");
    // A row that is neither the target nor one of its ancestors means the rerun did not run the target alone.
    await assert.rejects(workspace.rerun("main", file, base, "other"), /also ran "existing red", so it did not run the named test alone/);
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

/** The harness hook's result lines, with individual checks omitted in the negative fixtures. */
function harnessGate(t: TestContext, script: string, rule15 = true, rule25 = rule15, omit: string[] = []): string {
  const hooks = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-ship-hooks-`));
  const mark = join(hooks, "ran");
  const measured = (rule15 ? 'echo "rule15-precheck: OK -- no criterion field added or edited in the plan"\n' : "") +
    (rule25 ? 'echo "rule25-precheck: OK -- no instrument path rides with a src/ product path"\n' : "");
  const defaults = [
    "ci-control-plane-precheck: SKIP -- this diff does not change a control-plane or capability-snapshot input",
    "test-tier-manifest: OK — every row names an existing test file",
    "head-identity-gate: OK — identified via its run-shaped head ref",
    "worker-branch-shape: OK — no self-crediting plan filing",
    "proof-resolve-precheck: SKIP -- no task resolved from the branch or a Remudero-Task: trailer",
  ];
  const checks = defaults.filter((line) => !omit.some((name) => line.startsWith(name))).map((line) => `echo ${shellQuote(line)}\n`).join("");
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\n${measured}${checks}${script.replaceAll("$MARK", mark)}\n`);
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

function offlinePushRun(f: ReturnType<typeof fixture>, signal = new AbortController().signal, oldTip?: string) {
  return {
    dir: f.root, signal, log: f.options.write,
    git: ((cwd, args, options) => args[0] === "ls-remote"
      ? Promise.resolve(oldTip ? `${oldTip}\t${args[2]}\n` : "")
      : hostWorktreeGitAsync(cwd, args, options)) satisfies typeof hostWorktreeGitAsync,
  };
}

test("the source publisher sends one non-forced refspec pinned to the receipt head and refuses drift", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  repo.git("config", "--local", "core.hooksPath", "");
  const gate = harnessGate(t, 'cat > /dev/null; echo pass >> "$MARK"');
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const run = offlinePushRun(f);
  const source = await defaults.readSource(repo.dir, run);
  await withLiveWritesAllowed(() => defaults.push(source, run));
  // No `+`: a plain fast-forward refspec, leased on the absent ref the gate read (an empty lease: the ref must not exist).
  assert.deepEqual(requests, [["push", "origin", `${source.head}:refs/heads/${branch}`]], "no force option and no `+` refspec");
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
  const run = offlinePushRun(f);
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
    const run = offlinePushRun(f, undefined, oldTip);
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
  const run = offlinePushRun(f);
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
  const run = offlinePushRun(f, controller.signal);
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
  const run = offlinePushRun(f);
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
  const run = offlinePushRun(f);
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
    'import { test as trial, describe as group } from "node:test";',
    `const red = new Set(${JSON.stringify(red)});`,
    'group("parent", () => {',
    '  for (const name of ["alpha", "beta", "gamma"]) trial(`case ${name}`, () => {',
    '    console.log(`RAN CASE ${name}`);',
    '    if (red.has(name)) throw new Error(`red ${name}`);',
    '  });',
    '});',
    'trial("other", () => {});',
    "",
  ].join("\n");
  writeFileSync(join(repo.dir, file), cases(["alpha"]));
  repo.git("add", file, "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "a computed-title test is already red on main");
  const mainSha = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, file), "\n" + cases(["alpha", "beta"]));
  repo.git("commit", "-am", "the hand change turns another computed case red");
  const tap = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs"), file],
    { cwd: repo.dir, encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT" && key !== "NODE_OPTIONS")) });
  const named = failingTestsFromTap(tap.stdout, realpathSync(repo.dir)) as { file: string; title: string }[];
  assert.deepEqual(named.map((test) => test.title).sort(), ["parent > case alpha", "parent > case beta"], `${tap.stdout}\n${tap.stderr}`);
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
  assert.match(log, /also failing on main: test\/ci\/example\.test\.ts :: parent > case alpha$/m);
  assert.match(log, /caused by the change: test\/ci\/example\.test\.ts :: parent > case beta$/m);
  assert.deepEqual(reruns.sort(), ["head parent > case alpha", "head parent > case beta", "main parent > case alpha", "main parent > case beta"]);
  const commands = readFileSync(join(f.root, "commands.log"), "utf8");
  assert.doesNotMatch(commands, /RAN CASE gamma/, "a computed sibling's callback never executes");
  assert.equal(commands.match(/RAN CASE alpha/g)?.length, 2);
  assert.equal(commands.match(/RAN CASE beta/g)?.length, 2);
  assert.ok(!f.calls.some((call) => call.startsWith("push")), "a failure caused by the change never pushes");
});

test("W1-T12169 criterion 4: different declarations with the same runtime title cannot authorize publication", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo, true);
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  const cases = (onHead: boolean) => [
    'import { test } from "node:test";',
    'const title = "same title";',
    `const onHead = ${onHead};`,
    'if (onHead) test(title, () => { throw new Error("head declaration"); });',
    'else test(title, () => { throw new Error("main declaration"); });',
    "",
  ].join("\n");
  writeFileSync(join(repo.dir, file), cases(false));
  repo.git("add", file, "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "main's declaration fails");
  const baseSha = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, file), cases(true));
  repo.git("commit", "-am", "a different declaration fails with the same title");
  const defaults = handShipEffects(() => 0);
  f.options.cwd = repo.dir;
  f.effects.readSource = defaults.readSource;
  f.effects.prepare = async (_host, source, run) => {
    const isolated = await defaults.prepare({ ...linux, checkout: REPO_ROOT }, source, run);
    return { ...isolated, preflight: async () => ({ ...redReceipt(["same title"]), headSha: source.head, baseSha }) };
  };
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1, f.lines.join("\n"));
  assert.match(f.lines.join("\n"), /caused by the change: .* :: same title/m);
  assert.doesNotMatch(f.lines.join("\n"), /also failing on main/);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});

test("W1-T12169 criterion 4: no push when the control-plane or proof-resolution check did not complete", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const run = offlinePushRun(f);
  const source = await defaults.readSource(repo.dir, run);
  const push = () => withLiveWritesAllowed(() => defaults.push(source, run));
  const cases = [
    ["ci-control-plane-precheck", "could not read the diff — not blocking on an unreadable check", /CI control-plane/],
    ["proof-resolve-precheck", "could not read this head — not blocking on an unreadable check", /proof resolution/],
  ] as const;
  for (const [check, failure, reason] of cases) {
    harnessGate(t, `cat > /dev/null; echo ${shellQuote(`pre-push: ${check} ${failure}`)} >&2`, true, true, [check]);
    await assert.rejects(push(), reason);
    harnessGate(t, "cat > /dev/null", true, true, [check]);
    await assert.rejects(push(), reason);
  }
  await assert.rejects(withLiveWritesAllowed(() => defaults.push(source, { ...run, git: (cwd, args, options) =>
    args[0] === "ls-remote" ? Promise.reject(new Error("remote ref unreadable")) : run.git(cwd, args, options) })), /remote ref unreadable/);
  assert.deepEqual(requests, []);
  harnessGate(t, "cat > /dev/null");
  await push();
  assert.equal(requests.length, 1);
});

test("W1-T12169 criterion 5: stopping a publishing run does not wait on an irrelevant hooks-path read", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const path = process.env.PATH;
  const started = join(f.root, "started");
  const release = join(f.root, "release");
  const shim = join(f.root, "git");
  writeFileSync(shim, [
    "#!/bin/sh",
    'if [ "$3 $4 $5" = "config --get core.hooksPath" ]; then',
    `  echo hooks-path > ${shellQuote(started)}`,
    `  while [ ! -e ${shellQuote(release)} ]; do sleep .1; done`,
    "fi",
    `exec ${shellQuote(realGit)} "$@"`,
  ].join("\n"));
  chmodSync(shim, 0o755);
  t.after(() => { process.env.PATH = path; });
  process.env.PATH = `${f.root}:${path}`;
  harnessGate(t, "cat > /dev/null");
  const defaults = handShipEffects(() => 0, noOpenPull, async () => { f.calls.push("push"); return ""; });
  f.options.cwd = repo.dir;
  f.effects.readSource = defaults.readSource;
  f.workspace.preflight = async () => ({ ...receipt(), headSha: repo.git("rev-parse", "HEAD") });
  f.effects.push = (source, run) => withLiveWritesAllowed(() => defaults.push(source, { ...run, async git(cwd, args, options) {
    if (args[0] !== "ls-remote") return hostWorktreeGitAsync(cwd, args, options);
    writeFileSync(started, "remote-ref");
    await delay(60_000, undefined, { signal: options?.signal });
    return "";
  } }));
  const shipping = runHandShip(f.args, f.options, f.effects);
  let beforeRelease: number | undefined;
  try {
    for (let attempt = 0; !existsSync(started) && attempt < 250; attempt += 1) await delay(20);
    assert.ok(existsSync(started), f.lines.join("\n"));
    const state = join(f.root, "hand-ship");
    const id = readdirSync(state).find((entry) => entry.startsWith("rmd-ship-"))!;
    assert.equal(await runHandShip(["stop", id], f.options, f.effects), 0);
    beforeRelease = await Promise.race([shipping, delay(3_000, undefined, { ref: false })]);
    assert.equal(readFileSync(started, "utf8"), "remote-ref");
    assert.equal(JSON.parse(readFileSync(join(state, id, "status.json"), "utf8")).status, "stopped");
  } finally {
    writeFileSync(release, "");
    await shipping;
  }
  assert.equal(beforeRelease, 1);
  assert.ok(!f.calls.includes("push"));
});

test("W1-T12169 criterion 4: a required pre-push gate refuses a push whose Rule 25 check was unreadable or not measured", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const run = offlinePushRun(f);
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

/** The author receipt for a real red test file: its failures named by the installed TAP parser, as preflight names them. */
function realReceipt(repo: GitRepo, headSha: string, baseSha: string): ShipReceipt {
  const tap = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs"), file],
    { cwd: repo.dir, encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT" && key !== "NODE_OPTIONS")) });
  const named = failingTestsFromTap(tap.stdout, realpathSync(repo.dir)) as { file: string; title: string }[];
  const summary = testSummary(tap.stdout);
  return {
    headSha, baseSha, verdict: "failed",
    steps: [{ name: "census-precheck", ok: true }, { name: "static-preflight", ok: true }, {
      name: "affected-tests", ok: false, judge: { given: 1, reported: 1 }, diagnostics: { mayBeIncomplete: false },
      testSummary: { pass: summary.pass, fail: summary.fail, cancelled: summary.cancelled, tests: summary.tests },
    }],
    failureAttribution: { counts: { failingAtHead: named.length, unattributed: 0 }, tests: named },
  };
}

test("W1-T12169 criterion 3: the rerun isolates one test under a nested dynamic parent with public runner filters, and no sibling runs", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo, true);
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  const collision = "test/ci/collision.test.ts";
  writeFileSync(join(repo.dir, file), [
    'import { describe, it, test } from "node:test";',
    'const ran = (name: string) => console.log(`RAN ${name}`);',
    'describe("outer", () => {',
    '  it("before", () => ran("outer before"));',
    '  test("dynamic parent", async (context) => {',
    '    for (const name of ["one", "two"]) {',
    '      await context.test(`case ${name}`, () => { ran(`case ${name}`); if (name === "one") throw new Error("red"); });',
    '    }',
    '    await context.test("tail", () => ran("tail"));',
    '  });',
    '  it("after", () => ran("outer after"));',
    '});',
    'test("case one", () => ran("top-level case one"));',
    // The task's own example: "a b" > "c" and "a" > "b c" join to the same spaced name "a b c".
    'test("a b", async (context) => { await context.test("c", () => ran("a b > c")); });',
    'test("a", async (context) => { await context.test("b c", () => ran("a > b c")); await context.test("d", () => ran("a > d")); });',
    'test("hash # and back\\\\slash", () => ran("escaped name"));',
    'test("hash", () => ran("hash"));',
    "",
  ].join("\n"));
  writeFileSync(join(repo.dir, collision), [
    'import { test } from "node:test";',
    'test("a", async (context) => { await context.test("b c", () => {}); });',
    'test("a b c", () => console.log("RAN COLLISION"));',
    "",
  ].join("\n"));
  repo.git("add", file, collision, "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "nested, dynamic and space-colliding tests");
  const defaults = handShipEffects(() => 0);
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  const workspace = await defaults.prepare({ ...mac, target: "local", kind: "mac" as const, checkout: REPO_ROOT }, source, run);
  const commands = join(f.root, "commands.log");
  const ranSince = (from: number) => [...readFileSync(commands, "utf8").slice(from).matchAll(/RAN ([^\n]*)/g)].map((match) => match[1]);
  try {
    let from = 0;
    const nested = await workspace.rerun("head", file, source.head, "outer > dynamic parent > case one");
    assert.deepEqual(nested.map((row) => [row.title, row.failed]),
      [["outer > dynamic parent > case one", true], ["outer > dynamic parent", true], ["outer", true]], JSON.stringify(nested));
    assert.deepEqual(ranSince(from), ["case one"], "only the target's own body runs: no sibling at any depth, and not the top-level namesake");
    from = readFileSync(commands, "utf8").length;
    const spaced = await workspace.rerun("head", file, source.head, "a > b c");
    assert.deepEqual(spaced.map((row) => [row.title, row.failed]), [["a > b c", false], ["a", false]], JSON.stringify(spaced));
    assert.deepEqual(ranSince(from), ["a > b c"], "the other path to the same spaced name does not run");
    from = readFileSync(commands, "utf8").length;
    const collided = await workspace.rerun("head", collision, source.head, "a > b c");
    assert.deepEqual(collided.map((row) => [row.title, row.failed]), [["a > b c", false], ["a", false]], JSON.stringify(collided));
    assert.deepEqual(ranSince(from), [], "the top-level namesake's callback never runs");
    from = readFileSync(commands, "utf8").length;
    // Node's TAP writes `#` as `\#` and `\` as `\\`; the rerun selects the name Node registered.
    const escaped = await workspace.rerun("head", file, source.head, "hash \\# and back\\\\slash");
    assert.deepEqual(escaped.map((row) => [row.title, row.failed]), [["hash \\# and back\\\\slash", false]], JSON.stringify(escaped));
    assert.deepEqual(ranSince(from), ["escaped name"]);
    await assert.rejects(workspace.rerun("head", file, source.head, "line\\nbreak"), /TAP escape .* names more than one test/);
  } finally {
    await workspace.close();
  }
});

test("W1-T12169 criterion 3: a named failure on a branch whose package-lock.json differs from main is still rerun on main and classified", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo, true);
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  const lock = readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8");
  const tests = (red: string[]) => ['import { test } from "node:test";',
    ...["still red", "new red"].map((name) => `test(${JSON.stringify(name)}, () => { ${red.includes(name) ? 'throw new Error("red");' : ""} });`), ""].join("\n");
  writeFileSync(join(repo.dir, "package-lock.json"), `${lock}\n`);
  writeFileSync(join(repo.dir, file), tests(["still red"]));
  repo.git("add", file, "package-lock.json", "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "main locks other dependencies and is already red");
  const mainSha = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "package-lock.json"), lock);
  writeFileSync(join(repo.dir, file), tests(["still red", "new red"]));
  repo.git("commit", "-am", "the hand change moves the lockfile and adds a red");
  const installs: string[] = [];
  const defaults = handShipEffects(() => 0);
  const run: Parameters<HandShipEffects["readSource"]>[1] = {
    dir: f.root, signal: new AbortController().signal, log: f.options.write,
    spawn(command, args, options) {
      if (command !== "npm") return spawn(command, args, options);
      // Offline stand-in for main's own `npm ci`: the fixture's lockfiles differ only by a newline.
      installs.push(`${String(options.cwd)} ${args.join(" ")}`);
      return spawn("ln", ["-s", join(REPO_ROOT, "node_modules"), "node_modules"], options);
    },
  };
  const source = await defaults.readSource(repo.dir, run);
  const real = await defaults.prepare({ ...mac, target: "local", kind: "mac" as const, checkout: REPO_ROOT }, source, run);
  const reruns: string[] = [];
  f.effects.readSource = async () => source;
  f.effects.prepare = async () => ({
    preflight: async () => realReceipt(repo, source.head, mainSha),
    rerun: async (tree, target, sha, title, count) => { reruns.push(`${tree} ${title}`); return real.rerun(tree, target, sha, title, count); },
    close: () => real.close(),
  });
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1, f.lines.join("\n"));
  const log = f.lines.join("\n");
  assert.deepEqual(reruns, ["head still red", "head new red", "main still red", "main new red"], log);
  assert.equal(installs.length, 1, "main installs its own locked dependencies once");
  assert.match(installs[0]!, /\/main ci --no-audit --no-fund$/);
  assert.match(log, /also failing on main: test\/ci\/example\.test\.ts :: still red$/m);
  assert.match(log, /caused by the change: test\/ci\/example\.test\.ts :: new red$/m);
  assert.ok(!f.calls.some((call) => call.startsWith("push")), "a failure caused by the change never pushes");
});

test("W1-T12169 criterion 4: a remote already at the verified head gets no push, so a ref deleted after that read is never recreated unchecked", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const mark = harnessGate(t, 'cat > /dev/null; echo ran >> "$MARK"');
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (_cwd, args) => { requests.push([...args]); return ""; });
  const source = await defaults.readSource(repo.dir, offlinePushRun(f));
  // ls-remote answers the verified head; the ref may be gone by the time a push would reach the remote.
  await withLiveWritesAllowed(() => defaults.push(source, offlinePushRun(f, new AbortController().signal, source.head)));
  assert.deepEqual(requests, [], "nothing is sent: an ordinary push here would recreate a deleted ref with no check run");
  assert.equal(existsSync(mark), false);
  // Positive control: a remote without the head runs the gate and then pushes.
  await withLiveWritesAllowed(() => defaults.push(source, offlinePushRun(f)));
  assert.equal(readFileSync(mark, "utf8"), "ran\n");
  assert.deepEqual(requests, [["push", "origin", `${source.head}:refs/heads/${branch}`]]);
});

test("W1-T12169 criterion 5: a stoppable ship read still goes through a live broker, and a stop ends its wait there", async (t) => {
  const prefix = "rmd-hs-";
  const root = mkdtempSync(shortPathWhenTooLong(join(tmpdir(), prefix), (short) => join(short, prefix),
    (candidate) => Buffer.byteLength(join(`${candidate}XXXXXX`, "remudero", "gh-broker", "broker.sock")) <= MAX_UNIX_SOCKET_PATH_BYTES, existsSync));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: root })!;
  const upstream: { args: string[]; resolve: (result: GhUpstreamResult) => void }[] = [];
  const exec: GhUpstreamExec = (args) => args[1] === "user" ? Promise.resolve({ stdout: "octo\n", stderr: "", exitCode: 0 })
    : new Promise((resolve) => upstream.push({ args, resolve }));
  const server = await serveGhReadBroker({ dir, broker: new GhReadBroker(dir, exec, undefined, undefined, () => 1e12, { sharedPaceRoot: null }) });
  t.after(() => server.close());
  const saved = process.env.RMD_GH_CACHE_HOME;
  process.env.RMD_GH_CACHE_HOME = root;
  t.after(() => { if (saved === undefined) delete process.env.RMD_GH_CACHE_HOME; else process.env.RMD_GH_CACHE_HOME = saved; });
  const answer = (index: number) => upstream[index]!.resolve({ stdout: "HTTP/2.0 200 OK\r\nCache-Control: private, max-age=60\r\n\r\n[]", stderr: "", exitCode: 0 });
  const until = async (count: number) => {
    for (let waited = 0; upstream.length < count && waited < 10_000; waited += 20) await delay(20);
    assert.equal(upstream.length, count, "the read reached the live broker");
  };
  const { findPull } = handShipEffects(() => 0);
  const source = { root, branch, head, origin: "https://github.com/example/repo.git" };
  await withGhShim([{ when: "", stdout: "FALSIFIER: the real gh ran\n" }], async (shim) => {
    const run = { dir: root, signal: new AbortController().signal, log: () => {} };
    const found = findPull(source, run);
    await until(1);
    assert.match(upstream[0]!.args.join(" "), /repos\/example\/repo\/pulls\?state=open/);
    answer(0);
    assert.equal(await found, undefined);
    const stop = new AbortController();
    const stopped = findPull(source, { ...run, signal: stop.signal });
    await until(2);
    stop.abort(new Error("stop requested"));
    await assert.rejects(Promise.race([stopped, delay(3_000).then(() => "still waiting")]), /stop requested/);
    answer(1);
    assert.deepEqual(shim.calls(), [], "no ship read bypassed the broker for direct gh");
  });
});

test("W1-T12169 criterion 3: a nested failure whose space-joined name matches a top-level test is classified by its own row, never the other test's", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo, true);
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  // "a" > "b c" and the top-level "a b c" share the space-joined name the runner's filters match.
  const tests = (nestedRed: boolean, topRed: boolean) => ['import { test } from "node:test";',
    `test("a", async (context) => { await context.test("b c", () => { ${nestedRed ? 'throw new Error("nested red");' : ""} }); });`,
    `test("a b c", () => { console.log("RAN NAMESAKE"); ${topRed ? 'throw new Error("top-level red");' : ""} });`, ""].join("\n");
  // Main: the nested test passes and its namesake fails. Read as the target, the namesake would make it "also failing on main".
  writeFileSync(join(repo.dir, file), tests(false, true));
  repo.git("add", file, "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "main: only the top-level namesake is red");
  const mainSha = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, file), tests(true, false));
  repo.git("commit", "-am", "the hand change turns the nested test red and fixes its namesake");
  const defaults = handShipEffects(() => 0);
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  const real = await defaults.prepare({ ...mac, target: "local", kind: "mac" as const, checkout: REPO_ROOT }, source, run);
  const receipt = realReceipt(repo, source.head, mainSha);
  assert.deepEqual(receipt.failureAttribution!.tests!.map((test) => test.title).sort(), ["a", "a > b c"]);
  f.effects.readSource = async () => source;
  f.effects.prepare = async () => ({ preflight: async () => receipt, rerun: real.rerun, close: () => real.close() });
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1, f.lines.join("\n"));
  const log = f.lines.join("\n");
  assert.doesNotMatch(log, /comparison unavailable|also failing on main/, log);
  assert.match(log, /caused by the change: test\/ci\/example\.test\.ts :: a > b c$/m);
  assert.match(log, /caused by the change: test\/ci\/example\.test\.ts :: a$/m);
  assert.doesNotMatch(readFileSync(join(f.root, "commands.log"), "utf8"), /RAN NAMESAKE/, "the namesake's callback never runs on head or main");
  assert.ok(!f.calls.some((call) => call.startsWith("push")), "a failure caused by the change never pushes");
});

test("W1-T12169 criterion 3: a test red on head and main stays also failing on main after a formatting-only edit to its registration", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo, true);
  mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
  writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
  writeFileSync(join(repo.dir, file), 'import { test } from "node:test";\ntest("green", () => {});\ntest("same red", () => { throw new Error("red"); });\n');
  repo.git("add", file, "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "main: the test is red");
  const mainSha = repo.git("rev-parse", "HEAD");
  // Whitespace, a comment, quote style and a type annotation change; no token that runs.
  writeFileSync(join(repo.dir, file), [
    'import { test } from "node:test";', 'test("green", () => {});', "test(  'same red' ,", "  (): void => {", "    // still red", "    throw new Error( 'red' );", "  } );", "",
  ].join("\n"));
  repo.git("commit", "-am", "the hand change only reformats the red test");
  const defaults = handShipEffects(() => 0);
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(repo.dir, run);
  const real = await defaults.prepare({ ...mac, target: "local", kind: "mac" as const, checkout: REPO_ROOT }, source, run);
  f.effects.readSource = async () => source;
  f.effects.prepare = async () => ({ preflight: async () => realReceipt(repo, source.head, mainSha), rerun: real.rerun, close: () => real.close() });
  assert.equal(await runHandShip(f.args, f.options, f.effects), 0, f.lines.join("\n"));
  assert.match(f.lines.join("\n"), /also failing on main: test\/ci\/example\.test\.ts :: same red$/m);
  assert.doesNotMatch(f.lines.join("\n"), /caused by the change/);
  assert.ok(f.calls.includes(`push ${source.head}`));
});

test("W1-T12169 criterion 4: the push sends no force option, refuses a tip that moved after its gate, and a non-fast-forward never lands", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  const base = seedHandBranch(repo);
  repo.git("commit", "--allow-empty", "-m", "an intermediate commit the remote may advance to");
  const ancestor = repo.git("rev-parse", "HEAD");
  repo.git("commit", "--allow-empty", "-m", "the verified head");
  const verifiedHead = repo.git("rev-parse", "HEAD");
  const remote = gitRepo({ scope: t, bare: true, kind: "hand-ship-remote" }).dir;
  repo.git("push", "-q", remote, `${verifiedHead}:refs/heads/objects`, `${base}:refs/heads/${branch}`);
  const tip = () => execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
  // The race, inside the gate: after the gate read the tip, the remote advances to an ancestor of the head.
  const mark = harnessGate(t, `cat > /dev/null; git --git-dir=${shellQuote(remote)} update-ref refs/heads/${branch} "$(cat ${shellQuote(join(f.root, "advance"))})"; ` +
    'echo "open-pr-body-proof-precheck: SKIP -- this branch has no open pull request"; echo ran >> "$MARK"');
  const toRemote = (args: readonly string[]) => args.map((arg) => arg === "origin" ? remote : arg);
  const pushes: string[][] = [];
  const defaults = handShipEffects(() => 0, noOpenPull, async (cwd, args, options) => {
    pushes.push([...args]);
    return hostWorktreeGitAsync(cwd, toRemote(args), options);
  });
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write,
    git: ((cwd, args, options) => hostWorktreeGitAsync(cwd, args[0] === "ls-remote" ? toRemote(args) : args, options)) satisfies typeof hostWorktreeGitAsync };
  const source = await defaults.readSource(repo.dir, run);
  writeFileSync(join(f.root, "advance"), ancestor);
  await assert.rejects(withLiveWritesAllowed(() => defaults.push(source, run)), /remote ref moved after the pre-push gate read it/);
  assert.equal(readFileSync(mark, "utf8"), "ran\n");
  assert.deepEqual(pushes, [], "the gate judged the push from the base; a remote that moved since is not fast-forwarded on that result");
  assert.equal(tip(), ancestor);
  // A tip the head does not descend from is refused before the gate.
  repo.git("switch", "-q", "--detach", base);
  repo.git("commit", "--allow-empty", "-m", "someone else's commit");
  const foreign = repo.git("rev-parse", "HEAD");
  repo.git("push", "-q", remote, `${foreign}:refs/heads/${branch}`, "-f");
  repo.git("switch", "-q", branch);
  await assert.rejects(withLiveWritesAllowed(() => defaults.push(source, run)), /is not an ancestor of .* so this push could only replace it/);
  assert.deepEqual(pushes, []);
  assert.equal(tip(), foreign);
  // The argv the push sends, against that tip, is a non-fast-forward the remote itself refuses: nothing forces it.
  await assert.rejects(hostWorktreeGitAsync(repo.dir, ["push", remote, `${verifiedHead}:refs/heads/${branch}`]), /rejected|non-fast-forward|fetch first/);
  assert.equal(tip(), foreign);
  // Positive control: an unmoved tip the head descends from takes the plain fast-forward.
  execFileSync("git", ["--git-dir", remote, "update-ref", `refs/heads/${branch}`, base]);
  writeFileSync(join(f.root, "advance"), base);
  await withLiveWritesAllowed(() => defaults.push(source, run));
  assert.deepEqual(pushes, [["push", "origin", `${verifiedHead}:refs/heads/${branch}`]]);
  assert.ok(!pushes.flat().some((arg) => /^--force|^-f$|^\+/.test(arg)), "no force option and no `+` refspec");
  assert.equal(tip(), verifiedHead);
});

test("W1-T12169 criterion 2: a child that resolves node through PATH finds the pinned Node first, added to PATH, not replacing it", async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  const base = seedHandBranch(repo, true);
  writeFileSync(join(repo.dir, file), 'import { test } from "node:test"; test("existing red", () => { throw new Error("red"); });\n');
  repo.git("add", file);
  repo.git("commit", "-m", "name the test fixture");
  const pin = readFileSync(join(repo.dir, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  const pinned = process.versions.node === pin ? process.execPath
    : pinnedNodeReexec({ pin, current: process.versions.node, env: process.env }).reexec;
  assert.ok(pinned, "the .nvmrc Node is present on this host");
  // The operator's PATH, without the pinned Node's directory and with no configured pathPrefix.
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; });
  process.env.PATH = (path ?? "").split(delimiter).filter((entry) => entry !== dirname(pinned)).join(delimiter);
  const resolved: { what: string; node: string; path: string }[] = [];
  const defaults = handShipEffects(() => 0);
  const run: Parameters<HandShipEffects["readSource"]>[1] = {
    dir: f.root, signal: new AbortController().signal, log: f.options.write,
    spawn(command, args, options) {
      if (command !== "/usr/bin/nice") return spawn(command, args, options);
      const env = options.env ?? {};
      const node = spawnSync("sh", ["-c", "command -v node"], { env, encoding: "utf8" }).stdout.trim();
      const cwd = String(options.cwd);
      const preflight = args.includes("scripts/preflight-author.mjs");
      resolved.push({ what: preflight ? "preflight" : "rerun", node, path: String(env.PATH) });
      if (preflight) {
        mkdirSync(join(cwd, "coverage"), { recursive: true });
        writeFileSync(join(cwd, "coverage/preflight-author.json"), JSON.stringify({ ...redReceipt(["existing red"]),
          headSha: repo.git("rev-parse", "HEAD"), baseSha: base, version: 1, dryRun: false, publicationIdentity: { state: "passed", headRef: branch } }));
        return spawn(process.execPath, ["-e", "process.exitCode = 1"], options);
      }
      const tap = `not ok 1 - existing red\n  ---\n  location: '${join(cwd, file)}:1:1'\n  ...\n` +
        "# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n";
      return spawn(process.execPath, ["-e", "process.stdout.write(process.argv[1]); process.exitCode = 1", tap], options);
    },
  };
  const source = await defaults.readSource(repo.dir, run);
  const workspace = await defaults.prepare({ ...linux, kind: "mac" }, source, run);
  try {
    await workspace.preflight("low");
    await workspace.rerun("head", file, source.head, "existing red");
  } finally {
    await workspace.close();
  }
  assert.deepEqual(resolved.map((entry) => [entry.what, entry.node]), [["preflight", pinned], ["rerun", pinned]], JSON.stringify(resolved));
  for (const entry of resolved) {
    assert.equal(entry.path.split(delimiter)[0], dirname(pinned));
    assert.ok(entry.path.split(delimiter).includes("/usr/bin"), "the rest of PATH is kept");
  }
});

// W1-T12169 criterion 5, operator ruling (option 2, "Exempt ship stop only, logged"): the exact
// `hand-worktree ship stop <run-id>` argv passes the CLI freshness gate with one ledgered
// `self_sync.exempt` row; `ship`, worktree creation and any other stop shape stay refused.

class CliExit extends Error {
  constructor(readonly code: number | undefined) { super(`process.exit(${code})`); }
}

/** A real checkout BEHIND its origin whose uncommitted edit touches the very file origin moved. */
function behindWithOverlappingEdit(t: TestContext) {
  const origin = gitRepo({ scope: t });
  writeFileSync(join(origin.dir, "plan.yaml"), "- id: T1\n");
  origin.git("add", "plan.yaml");
  origin.git("commit", "-q", "-m", "plan");
  const local = gitRepo({ scope: t, cloneFrom: origin.dir });
  writeFileSync(join(origin.dir, "plan.yaml"), "- id: T1\n  title: newer\n");
  origin.git("commit", "-q", "-am", "newer");
  writeFileSync(join(local.dir, "plan.yaml"), "- id: T1\n  title: local edit\n");
  const merges: string[][] = [];
  // The real freshness check, pointed at the fixture: the CLI's own checkout is never assessed.
  const checkFreshness: typeof checkCliFreshness = (_dir, _env, deps = {}) => checkCliFreshness(local.dir, {}, {
    ...deps,
    git: (args) => {
      if (args[0] === "merge") { merges.push(args); throw new Error("the fixture is never merged"); }
      // Raw, untrimmed output, exactly as the check's own default runner returns it.
      return execFileSync("git", ["-C", local.dir, ...args], { encoding: "utf8" });
    },
  });
  const snapshot = () => [local.git("rev-parse", "HEAD"), local.git("status", "--porcelain"), readFileSync(join(local.dir, "plan.yaml"), "utf8")];
  return { checkFreshness, merges, snapshot };
}

/** Drives the CLI's real `main()` for one argv with HOME (so config, state and ledger) under a temp root. */
async function cliUnderGate(t: TestContext, argv: string[], deps: NonNullable<Parameters<typeof cliMain>[0]>, seed: (root: string) => void = () => {}) {
  const scratch = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}hand-ship-cli-`));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, "root");
  mkdirSync(join(scratch, "home", ".config", "remudero"), { recursive: true });
  writeFileSync(join(scratch, "home", ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
  seed(root);
  const saved = { HOME: process.env.HOME, a: process.env.RMD_SELECTED_INSTANCE_REGISTRY, b: process.env.RMD_INSTANCE_REGISTRY, argv: process.argv };
  // Installed with the real exit before process.exit is mocked, so main()'s own install is a no-op.
  installUnhandledRejectionGuard();
  const errs: string[] = [];
  const logs: string[] = [];
  t.mock.method(process, "exit", ((code?: number): never => { throw new CliExit(code); }) as typeof process.exit);
  t.mock.method(console, "error", (...a: unknown[]) => { errs.push(a.map(String).join(" ")); });
  t.mock.method(console, "log", (...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  process.env.HOME = join(scratch, "home");
  delete process.env.RMD_SELECTED_INSTANCE_REGISTRY;
  delete process.env.RMD_INSTANCE_REGISTRY;
  process.argv = ["node", "run-task.js", ...argv];
  let caught: unknown;
  try {
    await cliMain(deps).catch((error: unknown) => { caught = error; });
  } finally {
    process.argv = saved.argv;
    for (const [key, value] of [["HOME", saved.HOME], ["RMD_SELECTED_INSTANCE_REGISTRY", saved.a], ["RMD_INSTANCE_REGISTRY", saved.b]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (!(caught instanceof CliExit)) throw caught ?? new Error("main() returned without exiting");
  const ledger = join(root, "state", "ledger.ndjson");
  const rows = existsSync(ledger)
    ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  return { code: caught.code, errs, logs, root, rows: rows.filter((row) => String(row.step).startsWith("self_sync.")) };
}

const liveRunId = "rmd-ship-1795084765220-abc123";

/** A run this process holds open, as `ship` leaves it while it works. */
function seedLiveRun(root: string): string {
  const dir = join(root, "state", "hand-ship", liveRunId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ id: liveRunId, pid: process.pid, status: "preflight" }));
  return dir;
}

test("W1-T12169 criterion 5: a behind checkout with an overlapping edit still stops a live run by id, ledgering the exemption", async (t) => {
  const { checkFreshness, merges, snapshot } = behindWithOverlappingEdit(t);
  const before = snapshot();
  assert.equal(checkFreshness("", {}, { warn: () => {} }).status, "refused", "the fixture is a checkout the gate refuses");
  let runDir = "";
  const run = await cliUnderGate(t, ["hand-worktree", "ship", "stop", liveRunId], { checkFreshness }, (root) => { runDir = seedLiveRun(root); });
  assert.equal(run.code, 0, JSON.stringify(run));
  assert.ok(!run.errs.some((line) => line.includes("refusing to auto-sync")), JSON.stringify(run.errs));
  assert.ok(existsSync(join(runDir, "stop")), "the real stop handler wrote the stop marker");
  assert.ok(run.logs.includes(`${liveRunId}: stop requested`), JSON.stringify(run.logs));
  assert.deepEqual(run.rows.map((row) => [row.step, row.task_id, row.verb, row.reason]),
    [["self_sync.exempt", "CLI", "hand-worktree", `dirty (hand-worktree ship stop ${liveRunId})`]]);
  assert.match(String(run.rows[0]!.run_id), /^CLI-\d+$/);
  assert.deepEqual(snapshot(), before, "the checkout's HEAD, status and edit are untouched");
  assert.deepEqual(merges, [], "the assessment never merges");
});

test("W1-T12169 criterion 5: ship, worktree creation and every other stop shape still exit at the gate on that checkout", async (t) => {
  for (const argv of [
    ["hand-worktree", "ship", "--title", "fix(example): ship", "--body-file", "body.md"],
    ["hand-worktree", "ship"],
    ["hand-worktree", "unfiled"],
    ["hand-worktree", "ship", "stop"],
    ["hand-worktree", "ship", "stop", liveRunId, "extra"],
    ["hand-worktree", "ship", "stop", "--", liveRunId],
    ["hand-worktree", "ship", "stop", `${liveRunId}x`],
    ["hand-worktree", "stop", liveRunId],
    ["hand-worktree", "ship", "STOP", liveRunId],
  ]) {
    const { checkFreshness, snapshot } = behindWithOverlappingEdit(t);
    const before = snapshot();
    const dispatched: string[][] = [];
    let runDir = "";
    const run = await cliUnderGate(t, argv, {
      checkFreshness,
      dispatch: async (cmd, rest) => { dispatched.push([cmd ?? "", ...rest]); return 0; },
    }, (root) => { runDir = seedLiveRun(root); });
    const label = `rmd ${argv.join(" ")}`;
    assert.equal(run.code, 1, `${label} exits at the gate: ${JSON.stringify(run)}`);
    assert.ok(run.errs.some((line) => line.includes("refusing to auto-sync")), `${label} prints the refusal`);
    assert.deepEqual(dispatched, [], `${label} never reaches its dispatch`);
    assert.equal(existsSync(join(runDir, "stop")), false, `${label} writes no stop marker`);
    assert.deepEqual(run.rows.map((row) => row.step), ["self_sync.refused"], `${label} is ledgered as refused, never exempt`);
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(handShipStopRunId("hand-worktree", ["ship", "stop", liveRunId]), liveRunId);
  assert.equal(handShipStopRunId("doctor", ["ship", "stop", liveRunId]), undefined);
});
