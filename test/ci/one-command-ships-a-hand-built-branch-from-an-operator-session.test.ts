import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
// @ts-expect-error The installed author entrypoint has no declaration file.
import { authorPushEligibility, pinnedNodeReexec } from "#scripts/preflight-author.mjs";
import { handShipEffects, runHandShip, type HandShipEffects, type ShipReceipt } from "#src/lib/hand-ship.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { HANDLERS } from "#test/helpers/run-task-test.js";

const head = "1".repeat(40);
const main = "2".repeat(40);
const branch = "run-unfiled-123";
const file = "test/ci/example.test.ts";
const mac = { name: "mac", target: "mac.example", kind: "mac", checkout: "/donor" };
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
    tests: titles.map((title) => ({ file, title })) };
  return result;
}

function rerunResults(titles: string[]) {
  return titles.map((title) => ({ file, title, failed: true }));
}

function passingResults(titles: string[]) {
  return titles.map((title) => ({ file, title, failed: false }));
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
    readFailures: async () => [],
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

test("an exact named test that reruns green is classified as host-caused", async (t) => {
  const f = fixture(t);
  f.workspace.preflight = async () => redReceipt(["original failure"]);
  f.workspace.readFailures = async () => rerunResults(["original failure"]);
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
  f.workspace.readFailures = async () => rerunResults(["head contract failure"]);
  f.workspace.rerun = async (tree, target, _sha, title) => {
    f.calls.push(`${tree} ${target} ${title}`);
    return tree === "head" ? rerunResults(["head contract failure"]) : rerunResults(["main contract failure"]);
  };
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.match(f.lines.join("\n"), /caused by the change.*head contract failure/);
  assert.deepEqual(f.calls.filter((call) => /^(head|main) /.test(call)),
    [`head ${file} head contract failure`, `main ${file} head contract failure`]);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});

test("a named static failure is attributed to the change without rerunning tests", async (t) => {
  const f = fixture(t);
  const staticRed = receipt();
  staticRed.verdict = "failed";
  staticRed.steps[1] = { name: "static-preflight", ok: false, failedCheck: "typecheck" };
  f.workspace.preflight = async () => staticRed;
  f.workspace.rerun = async () => assert.fail("static failures must not run tests again");
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1);
  assert.match(f.lines.join("\n"), /caused by the change.*typecheck/);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
});

test("W1-T12169 criterion 5 stops the pinned Git child before admitting the next queued run", { timeout: 12_000 }, async (t) => {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  seedHandBranch(repo);
  const defaults = handShipEffects(() => 0);
  const state = join(f.root, "hand-ship");
  let started!: (child: ChildProcess) => void;
  const bundleStarted = new Promise<ChildProcess>((resolve) => { started = resolve; });
  let gitClosed = false;
  let launches = 0;
  writeFileSync(join(f.root, "hand-ship-hosts.json"), JSON.stringify([linux]));
  f.effects.readSource = (cwd, run) => defaults.readSource(repo.dir, run);
  f.effects.prepare = (host, source, run) => {
    if (++launches > 1) {
      assert.equal(gitClosed, true, "the queue stays locked until the Git child closes");
      return Promise.resolve({ ...f.workspace, preflight: async () => ({ ...receipt(), headSha: source.head }) });
    }
    return defaults.prepare(host, source, { ...run, spawn(command, args, options) {
      if (command !== "git" || !args.includes("bundle")) return spawn(command, args, options);
      assert.equal(options.env?.GIT_WORK_TREE, repo.dir);
      // Keep a real Git process blocked on its batch input to model a stalled bundle.
      const child = spawn(command, ["cat-file", "--batch"], { ...options, stdio: ["pipe", "pipe", "pipe"] });
      t.after(() => { if (!gitClosed) child.kill("SIGKILL"); });
      child.once("spawn", () => started(child));
      child.once("close", () => { gitClosed = true; });
      return child;
    } });
  };
  const first = runHandShip(f.args, f.options, f.effects);
  const child = await Promise.race([bundleStarted, first.then(() => assert.fail(f.lines.join("\n")))]);
  assert.equal(child.exitCode, null);
  const id = readdirSync(state).find((name) => /^rmd-ship-/.test(name))!;
  const second = runHandShip(f.args, f.options, f.effects);
  await delay(50);
  assert.equal(launches, 1);
  assert.equal(await runHandShip(["stop", "../invalid"], f.options, f.effects), 2);
  assert.equal(await runHandShip(["stop", id], f.options, f.effects), 0);
  assert.equal(await first, 1);
  assert.ok(gitClosed);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(await second, 0);
  assert.equal(await runHandShip(["stop", id], f.options, f.effects), 1);
  assert.equal(JSON.parse(readFileSync(join(state, id, "status.json"), "utf8")).status, "stopped");
  assert.equal(launches, 2);
  assert.equal(f.calls.filter((call) => call.startsWith("push ")).length, 1);
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
  f.workspace.preflight = async () => partial;
  f.workspace.readFailures = async () => rerunResults(["one red"]);
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

test("one occurrence on main accounts for only one duplicate failure", async (t) => {
  const f = fixture(t);
  f.workspace.preflight = async () => redReceipt(["duplicate", "duplicate"]);
  f.workspace.readFailures = async () => rerunResults(["duplicate", "duplicate"]);
  f.workspace.rerun = async (tree) => rerunResults(tree === "head" ? ["duplicate", "duplicate"] : ["duplicate"]);
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1, f.lines.join("\n"));
  assert.match(f.lines.join("\n"), /also failing on main.*duplicate/);
  assert.match(f.lines.join("\n"), /caused by the change.*duplicate/);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
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

function seedHandBranch(repo: GitRepo, withTest = false, baseContents?: string): string {
  repo.addRemote("origin", "https://github.com/example/repo.git");
  writeFileSync(join(repo.dir, "package-lock.json"), baseContents === undefined ? "{}\n" : readFileSync(join(REPO_ROOT, "package-lock.json")));
  writeFileSync(join(repo.dir, ".nvmrc"), readFileSync(join(REPO_ROOT, ".nvmrc"), "utf8"));
  writeFileSync(join(repo.dir, ".gitignore"), "node_modules\ncoverage/\n");
  mkdirSync(join(repo.dir, "node_modules"));
  if (withTest) {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), baseContents ?? "");
    repo.git("add", file);
  }
  if (baseContents !== undefined) {
    mkdirSync(join(repo.dir, "test/setup"), { recursive: true });
    writeFileSync(join(repo.dir, "test/setup/tmp-hygiene.ts"), "");
    repo.git("add", "test/setup/tmp-hygiene.ts");
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
    assert.deepEqual(await workspace.rerun("main", file, base, "existing red"), []);
    await assert.rejects(workspace.rerun("head", file, base, "existing red"), /head changed before the isolated rerun/);
    await assert.rejects(workspace.rerun("head", file, source.head, "existing red"), /head test .* failed/);
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
    assert.deepEqual(await workspace.rerun("head", file, source.head, "existing red"), [
      { file, title: "existing red", failed: true },
    ]);
    assert.ok(spawned.at(-1)!.includes("--test-name-pattern"), "the isolated rerun selects the named failure");
    assert.deepEqual(await workspace.rerun("main", file, base, "existing red"), [
      { file, title: "existing red", failed: true },
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
    assert.deepEqual(await workspace.rerun("main", file, base, "existing red"), []);
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

function productionComparison(t: TestContext, mixedFailures: boolean) {
  const f = fixture(t);
  const repo = gitRepo({ scope: t });
  const baseTest = `
import { test } from "node:test";
test("parent", async (context) => {
  await context.test("leaf [matches]", () => { throw new Error("existing red"); });
  await context.test("sibling", () => {
    if (!process.env.HAND_SHIP_INITIAL) throw new Error("sibling body ran");
  });
});
test("host red", () => {
  if (process.env.HAND_SHIP_INITIAL && ${mixedFailures}) throw new Error("host red");
});
test("regression", () => {});
`;
  const base = seedHandBranch(repo, true, baseTest);
  const headTest = "\n// The old failure moves down two lines.\n" + baseTest.replace('test("regression", () => {});',
    mixedFailures ? 'test("regression", () => { throw new Error("change red"); });' : 'test("regression", () => {});');
  writeFileSync(join(repo.dir, file), headTest);
  repo.git("add", file);
  repo.git("commit", "-m", "shift the test locations");
  writeFileSync(join(f.root, "hand-ship-hosts.json"), JSON.stringify([{ ...linux, checkout: REPO_ROOT }]));
  const initial = `
    const { spawnSync } = require("node:child_process");
    const { mkdirSync, writeFileSync } = require("node:fs");
    const [file, raw] = process.argv.slice(1);
    const receipt = JSON.parse(raw);
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", "tsx", file],
      { encoding: "utf8", env: { ...process.env, HAND_SHIP_INITIAL: "1" } });
    if (result.status !== 1) throw new Error(result.stderr || result.stdout);
    const log = "coverage/rmd-author-ABC123/affected-tests.stdout.log";
    mkdirSync("coverage/rmd-author-ABC123", { recursive: true });
    writeFileSync(log, result.stdout);
    const step = receipt.steps[2];
    step.diagnostics.stdout = log;
    step.testSummary = Object.fromEntries(Array.from(result.stdout.matchAll(/^# (pass|fail|cancelled) ([0-9]+)$/gm),
      ([, field, count]) => [field, Number(count)]));
    writeFileSync("coverage/preflight-author.json", JSON.stringify(receipt));
    process.exitCode = 1;
  `;
  const prepare = (defaults: HandShipEffects): HandShipEffects["prepare"] => (host, source, run) => defaults.prepare(host, source, {
    ...run,
    spawn(command, args, options) {
      if (!args.includes("scripts/preflight-author.mjs")) return spawn(command, args, options);
      const original = { ...redReceipt([]), headSha: source.head, baseSha: base, version: 1, dryRun: false,
        publicationIdentity: { state: "passed", headRef: branch }, failureAttribution: undefined };
      return spawn(process.execPath, ["-e", initial, file, JSON.stringify(original)], options);
    },
  });
  const defaults = handShipEffects(() => 0);
  f.effects.readSource = (_cwd, run) => defaults.readSource(repo.dir, run);
  f.effects.prepare = prepare(defaults);
  return { ...f, repo, base };
}

test("W1-T12169 criterion 3 classifies real TAP reruns without executing nested siblings", async (t) => {
  const f = productionComparison(t, true);
  assert.equal(await runHandShip(f.args, f.options, f.effects), 1, f.lines.join("\n"));
  assert.match(f.lines.join("\n"), /selected azure/);
  const sha = f.repo.git("rev-parse", "HEAD");
  assert.deepEqual(f.lines.filter((line) => line.includes("isolated rerun")).map((line) => line.split("isolated rerun on ")[1]), [
    ...["parent > leaf [matches]", "host red", "regression"].map((title) => `head ${sha} ${file} :: ${title}`),
    ...["parent > leaf [matches]", "host red", "regression"].map((title) => `main ${f.base} ${file} :: ${title}`),
  ]);
  assert.match(f.lines.join("\n"), /caused by the host.*host red/);
  assert.match(f.lines.join("\n"), /also failing on main.*parent > leaf/);
  assert.match(f.lines.join("\n"), /caused by the change.*regression/);
  assert.ok(!f.calls.some((call) => call.startsWith("push")));
  const state = join(f.root, "hand-ship");
  const log = readFileSync(join(state, readdirSync(state).find((name) => /^rmd-ship-/.test(name))!, "commands.log"), "utf8");
  assert.match(log, /ok 1 - host red\n  ---\n  duration_ms: [^\n]+\n  type: 'test'\n  \.\.\./);
  assert.doesNotMatch(log, /sibling body ran/);
});

test("W1-T12169 criterion 4 ships named main reds despite line shifts and runs the guarded push checks", async (t) => {
  const f = productionComparison(t, false);
  const remote = gitRepo({ scope: t, bare: true });
  const hooks = join(f.root, "hooks");
  const bin = join(f.root, "bin");
  const attempts = join(f.root, "gate-attempts");
  const refuse = join(f.root, "gate-refusal");
  mkdirSync(hooks);
  mkdirSync(bin);
  const nativeGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "${'${3-}'}" = ls-remote ]; then exec "${nativeGit}" ls-remote "${remote.dir}" "$5"; fi
exec "${nativeGit}" "$@"
`, { mode: 0o755 });
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh
[ "${'${RMD_PREPUSH_GATES:-}'}" = 0 ] && exit 0
cat >> "${attempts}"
test ! -e "${refuse}"
`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, RMD_HARNESS_HOOKS_DIR: process.env.RMD_HARNESS_HOOKS_DIR,
    RMD_PREPUSH_GATES: process.env.RMD_PREPUSH_GATES };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.RMD_HARNESS_HOOKS_DIR = hooks;
  process.env.RMD_PREPUSH_GATES = "0";
  const requests: string[][] = [];
  const defaults = handShipEffects(() => 0, undefined, async (_cwd, args) => {
    requests.push([...args]);
    return f.repo.git("push", remote.dir, args.at(-1)!);
  });
  f.effects.push = defaults.push;
  const sha = f.repo.git("rev-parse", "HEAD");
  writeFileSync(refuse, "");
  assert.equal(await withLiveWritesAllowed(() => runHandShip(f.args, f.options, f.effects)), 1, f.lines.join("\n"));
  assert.equal(requests.length, 0, "a refused check prevents transport");
  assert.match(readFileSync(attempts, "utf8"), new RegExp(`^${sha} ${sha} refs/heads/${branch} `));
  assert.ok(!f.calls.includes("publish"));
  rmSync(refuse);
  assert.equal(await withLiveWritesAllowed(() => runHandShip(f.args, f.options, f.effects)), 0, f.lines.join("\n"));
  assert.match(f.lines.join("\n"), /also failing on main.*parent > leaf/);
  assert.deepEqual(requests, [["push", "origin", `${sha}:refs/heads/${branch}`]]);
  assert.equal(remote.git("rev-parse", `refs/heads/${branch}`), sha);
  assert.deepEqual(f.calls.slice(-2), ["publish", "check stored body"]);
  assert.equal(process.env.RMD_PREPUSH_GATES, "0", "the override is confined to the check child");
  const run = { dir: f.root, signal: new AbortController().signal, log: f.options.write };
  const source = await defaults.readSource(f.repo.dir, run);
  f.repo.git("commit", "--allow-empty", "-m", "head moved after receipt");
  await assert.rejects(defaults.push(source, run), /changed during verification/);
  assert.equal(requests.length, 1);
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
