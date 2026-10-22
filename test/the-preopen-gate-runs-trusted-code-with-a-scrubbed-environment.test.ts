/**
 * W1-T9619 — THE PRE-OPEN GATE RUNS TRUSTED CODE WITH A SCRUBBED ENVIRONMENT.
 *
 * Every gate run here is a real child: a fake sandbox binary (a node script that records its argv and runs the
 * command after `--`) stands in for bubblewrap where the host has none, and a fake harness rmd records the argv and
 * environment it received, writes the summary it was asked for and exits with the status a test chose. The real
 * sandbox runs in the last test where the host can start it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { CHILD_ENTRY_SPAWNED_STEP } from "#src/lib/child-entry-argv.js";
import {
  defaultGateContainment, defaultRunGate, findOnPath, GATE_FAILED_NO_STEP_NAMED, GATE_SUMMARY_NAME, preopenGateCommand,
  preopenGateEnv, preopenGateLaunch, preopenGateLedgerFields, preopenGateSandboxArgv, PREOPEN_GATE_ENV_ALLOWLIST,
  PREOPEN_GATE_ENV_ALLOWLIST_NAME, renderPreopenGatePrompt, runPreopenGate, type GateContain, type GateContainInput,
} from "#src/lib/preopen-gate.js";
import { PROOF_ENV_ALLOWLIST } from "#src/lib/review.js";
import { TEST_SLOT_DIR_ENV, TEST_SLOTS_ENV } from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function scratch(kind: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9619-${kind}-`)));
  dirs.push(dir);
  return dir;
}

/** A node script at `path` running `body` (CommonJS: `fs`, `cp` and `args` in scope). */
function nodeScript(path: string, body: string): string {
  writeFileSync(path, `#!${process.execPath}\nconst fs = require("fs"); const cp = require("child_process"); const args = process.argv.slice(2);\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A sandbox binary that records its argv to `<dir>/sandbox-argv.json` and runs the command after the first `--`. */
function fakeSandbox(dir: string): string {
  return nodeScript(join(dir, "fake-bwrap"),
    `fs.writeFileSync(${JSON.stringify(join(dir, "sandbox-argv.json"))}, JSON.stringify(args));\n` +
    `const at = args.indexOf("--"); const r = cp.spawnSync(args[at + 1], args.slice(at + 2), { stdio: "inherit" });\n` +
    `process.exit(r.status === null ? 128 : r.status);`);
}
const contained = (binary: string): GateContain => async () => ({ mode: "sandboxed", file: binary, argv: ["--"] });

interface HarnessOutcome {
  exit: number;
  /** Steps for the summary written to `--summary-file`; `undefined` writes none. */
  steps?: Array<{ name: string; ok: boolean }>;
}

/** A harness rmd that records `{ argv, env, cwd }` to `<dir>/harness-ran.json`, writes the requested summary, and exits. */
function fakeHarnessRmd(dir: string, outcome: HarnessOutcome): string {
  return nodeScript(join(dir, "rmd"),
    `fs.writeFileSync(${JSON.stringify(join(dir, "harness-ran.json"))}, JSON.stringify({ argv: args, env: process.env, cwd: process.cwd() }));\n` +
    (outcome.steps === undefined ? "" :
      `const at = args.indexOf("--summary-file");\n` +
      `fs.writeFileSync(args[at + 1], JSON.stringify({ ok: ${outcome.steps.every((s) => s.ok)}, finishedAt: new Date().toISOString(), steps: ${JSON.stringify(outcome.steps)} }));\n`) +
    `process.exit(${outcome.exit});`);
}
const harnessRan = (dir: string): { argv: string[]; env: Record<string, string>; cwd: string } => JSON.parse(readFileSync(join(dir, "harness-ran.json"), "utf8"));

/** A worktree that holds its own bin/rmd, which records that it ran, and a fresh PASSING summary of its own. */
function coreBuildDir(): string {
  const work = scratch("core");
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "remudero" }));
  mkdirSync(join(work, "bin"));
  nodeScript(join(work, "bin", "rmd"), `fs.writeFileSync(${JSON.stringify(join(work, "worktree-rmd-ran"))}, args.join(" ")); process.exit(0);`);
  plantPassingSummary(work);
  return work;
}
function plantPassingSummary(work: string): void {
  mkdirSync(join(work, "coverage"), { recursive: true });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  writeFileSync(join(work, "coverage", "preflight-summary.json"), JSON.stringify({ ok: true, finishedAt: future, steps: [] }));
}

const CREDENTIAL_SENTINEL = "w1t9619-sentinel";
const DARWIN_RUNTIME_KEY = "__CF_USER_TEXT_ENCODING";

/** Test-only classification of the child observation, never a forwarding permission. */
function assertNoCredentialEnv(env: Record<string, string>, platform: NodeJS.Platform = process.platform): void {
  for (const [key, value] of Object.entries(env)) {
    assert.ok(!String(value).includes(CREDENTIAL_SENTINEL), `${key} carries a credential sentinel`);
    // These runtime additions do not authorize the application to forward either key.
    if (key === "NODE_V8_COVERAGE" || (platform === "darwin" && key === DARWIN_RUNTIME_KEY)) continue;
    assert.ok((PREOPEN_GATE_ENV_ALLOWLIST as readonly string[]).includes(key), `${key} is not on the allowlist`);
  }
}

test("W1-T10080: only the measured Darwin key is platform-added", () => {
  // BACKSTOP: the real empty-env control must finish; no application wrapper or inherited environment is used.
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
    env: {}, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.signal, null);
  const observed = JSON.parse(child.stdout) as Record<string, string>;
  const platformKeys = Object.keys(observed).filter((key) => key !== "NODE_V8_COVERAGE").sort();
  assert.deepEqual(platformKeys, process.platform === "darwin" ? [DARWIN_RUNTIME_KEY] : []);
  assertNoCredentialEnv(observed);
  assert.throws(() => assertNoCredentialEnv({ [DARWIN_RUNTIME_KEY]: "runtime metadata" }, "linux"), /is not on the allowlist/);
});

test("W1-T10080: metadata cannot hide a credential sentinel", () => {
  for (const key of [DARWIN_RUNTIME_KEY, "NODE_V8_COVERAGE", "GH_TOKEN", "UNKNOWN_APP_KEY", "PATH"]) {
    assert.throws(() => assertNoCredentialEnv({ [key]: `prefix-${CREDENTIAL_SENTINEL}-suffix` }, "darwin"),
      /carries a credential sentinel/, `${key} must not bypass the value check`);
  }
  for (const platform of ["darwin", "linux"] as const) {
    assert.throws(() => assertNoCredentialEnv({ UNKNOWN_APP_KEY: "not a credential" }, platform), /is not on the allowlist/);
  }
  assert.throws(() => assertNoCredentialEnv({ __CF_UNAPPROVED_KEY: "runtime metadata" }, "darwin"), /is not on the allowlist/);
  assert.throws(() => assertNoCredentialEnv({ NODE_V8_COVERAGE: "coverage metadata", GH_TOKEN: "not a canary" }, "darwin"), /is not on the allowlist/);
  assert.doesNotThrow(() => assertNoCredentialEnv({ NODE_V8_COVERAGE: "coverage metadata" }, "linux"));
});

test("W1-T10080: the application still drops parent-only keys", () => {
  const env = preopenGateEnv("/tmp/gate-home", {
    PATH: "/usr/bin", HOME: "/parent-home", [DARWIN_RUNTIME_KEY]: CREDENTIAL_SENTINEL,
    UNKNOWN_APP_KEY: CREDENTIAL_SENTINEL, NODE_V8_COVERAGE: CREDENTIAL_SENTINEL,
  });
  assert.equal(env.HOME, "/tmp/gate-home");
  assert.equal(env.PATH, "/usr/bin");
  for (const key of [DARWIN_RUNTIME_KEY, "UNKNOWN_APP_KEY", "NODE_V8_COVERAGE"]) assert.equal(env[key], undefined, key);
  assert.deepEqual([...PREOPEN_GATE_ENV_ALLOWLIST], [...PROOF_ENV_ALLOWLIST, TEST_SLOT_DIR_ENV, TEST_SLOTS_ENV]);
  assert.ok(!(PREOPEN_GATE_ENV_ALLOWLIST as readonly string[]).includes(DARWIN_RUNTIME_KEY));
  for (const key of Object.keys(env)) assert.ok((PREOPEN_GATE_ENV_ALLOWLIST as readonly string[]).includes(key), key);
});

test("W1-T9619: a gate run sees no credential environment variables", async () => {
  const sentinels = { GH_TOKEN: "w1t9619-sentinel-gh", ANTHROPIC_API_KEY: "w1t9619-sentinel-model", GH_APP_ID: "w1t9619-sentinel-app" };
  const saved = Object.fromEntries(Object.keys(sentinels).map((k) => [k, process.env[k]]));
  Object.assign(process.env, sentinels);
  try {
    const work = coreBuildDir();
    const harness = scratch("harness");
    const rmd = fakeHarnessRmd(harness, { exit: 0, steps: [] });
    const result = await runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, rmd, undefined, {}, { contain: contained(fakeSandbox(harness)) }) });
    assert.equal(result.kind, "pass", JSON.stringify(result));
    const { env } = harnessRan(harness);
    assertNoCredentialEnv(env);
    assert.notEqual(env.HOME, process.env.HOME, "the gate gets a throwaway HOME, never the daemon's");
    assert.ok(!existsSync(env.HOME), "the throwaway HOME is removed once the gate settles");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("W1-T9619: the allowlist is the proof children's plus the host test-slot pair, and nothing else crosses", () => {
  assert.deepEqual([...PREOPEN_GATE_ENV_ALLOWLIST], [...PROOF_ENV_ALLOWLIST, TEST_SLOT_DIR_ENV, TEST_SLOTS_ENV]);
  const env = preopenGateEnv("/tmp/gate-home", {
    PATH: "/usr/bin", HOME: "/home/daemon", GH_TOKEN: "t", NODE_OPTIONS: "--require /evil.js", RMD_SELF_SYNC_DONE: "1",
    [TEST_SLOT_DIR_ENV]: "/slots", [TEST_SLOTS_ENV]: "2", GIT_CONFIG_COUNT: "3",
  });
  assert.equal(env.HOME, "/tmp/gate-home");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env[TEST_SLOT_DIR_ENV], "/slots");
  assert.equal(env[TEST_SLOTS_ENV], "2");
  for (const key of ["GH_TOKEN", "NODE_OPTIONS", "RMD_SELF_SYNC_DONE", "GIT_CONFIG_COUNT"]) assert.equal(env[key], undefined, key);
  for (const key of Object.keys(env)) assert.ok((PREOPEN_GATE_ENV_ALLOWLIST as readonly string[]).includes(key), key);
});

test("W1-T9619: a gate run never executes bin/rmd from the worktree", async () => {
  const work = coreBuildDir();
  const harness = scratch("harness-root");
  mkdirSync(join(harness, "bin"));
  fakeHarnessRmd(join(harness, "bin"), { exit: 0, steps: [] });
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const result = await runPreopenGate(work, {
    runGate: (cwd) => defaultRunGate(cwd, undefined, (step, extra) => rows.push({ step, extra }), {}, { contain: contained(fakeSandbox(harness)), harnessRoot: harness }),
  });
  assert.equal(result.kind, "pass", JSON.stringify(result));
  assert.ok(!existsSync(join(work, "worktree-rmd-ran")), "the worktree's own bin/rmd ran");
  const ran = harnessRan(join(harness, "bin"));
  assert.deepEqual(ran.argv.slice(0, 4), ["preflight", "--fast", "--repo-root", work]);
  assert.equal(ran.argv[4], "--summary-file");
  assert.ok(!ran.argv[5]!.startsWith(work), "the summary the harness reads is written outside the worktree");
  const spawned = rows.filter((r) => r.step === CHILD_ENTRY_SPAWNED_STEP);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.extra?.launcher, "harness");
  assert.equal(spawned[0]!.extra?.containment, "sandboxed");
  assert.equal(spawned[0]!.extra?.env_allowlist, PREOPEN_GATE_ENV_ALLOWLIST_NAME);
  // The launch itself: a core worktree's bin/rmd is never the file, with or without a harness bundle.
  assert.deepEqual(preopenGateLaunch(work, () => {}, "/h/bin/rmd", harness), { file: "/h/bin/rmd", args: ["preflight", "--fast", "--repo-root", work] });
  assert.deepEqual(preopenGateCommand(work, "/h/bin/rmd", ["--summary-file", "/s"]), { file: "/h/bin/rmd", args: ["preflight", "--fast", "--repo-root", work, "--summary-file", "/s"] });
});

test("W1-T9619: a worker-written preflight summary is not trusted", async () => {
  const work = coreBuildDir();
  const run = async (outcome: HarnessOutcome) => {
    const harness = scratch("harness");
    const rmd = fakeHarnessRmd(harness, outcome);
    return runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, rmd, undefined, {}, { contain: contained(fakeSandbox(harness)) }) });
  };
  // A failing run that names its step is a fail, though the worktree holds a fresh passing summary.
  const failed = await run({ exit: 1, steps: [{ name: "jscpd", ok: false }, { name: "claims", ok: true }] });
  assert.deepEqual(failed.kind === "fail" ? [failed.failedSteps, failed.containment] : failed, [["jscpd"], "sandboxed"]);
  // A failing run that wrote no summary is unmeasured — never the worktree's pass.
  const silent = await run({ exit: 1 });
  assert.equal(silent.kind, "unmeasured", JSON.stringify(silent));
  assert.match(silent.kind === "unmeasured" ? silent.reason : "", /no readable preflight summary/);
  // A failing run whose summary names no failing step is still a fail, under a named placeholder.
  const unnamed = await run({ exit: 1, steps: [{ name: "claims", ok: true }] });
  assert.deepEqual(unnamed.kind === "fail" ? unnamed.failedSteps : [], [GATE_FAILED_NO_STEP_NAMED]);
  // Any other status is unmeasured.
  const odd = await run({ exit: 3, steps: [] });
  assert.equal(odd.kind === "unmeasured" ? odd.reason : "", "the fast gate exited 3");
});

test("W1-T9619: a gate that cannot be contained is unmeasured, never a pass", async () => {
  const work = coreBuildDir();
  const harness = scratch("harness");
  const rmd = fakeHarnessRmd(harness, { exit: 0, steps: [] });
  const refuse: GateContain = async () => ({ mode: "unavailable", reason: "bwrap is not installed" });
  const result = await runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, rmd, undefined, {}, { contain: refuse }) });
  assert.equal(result.kind, "unmeasured", JSON.stringify(result));
  assert.equal(result.kind === "unmeasured" ? result.reason : "", "the gate could not be contained: bwrap is not installed");
  assert.equal(result.containment, "unmeasured");
  assert.ok(!existsSync(join(harness, "harness-ran.json")), "nothing ran outside the sandbox");
  assert.ok(!existsSync(join(work, "worktree-rmd-ran")), "nothing ran from the worktree either");
  assert.deepEqual(preopenGateLedgerFields(result), { launcher: "harness", containment: "unmeasured", env_allowlist: PREOPEN_GATE_ENV_ALLOWLIST_NAME });
  // A containment that throws starts nothing either, and says so.
  const thrown = await runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, rmd, undefined, {}, { contain: () => { throw new Error("no namespace"); } }) });
  assert.deepEqual(thrown.kind === "unmeasured" ? [thrown.reason, thrown.containment] : thrown, ["the gate could not start: no namespace", undefined]);
  assert.ok(!existsSync(join(harness, "harness-ran.json")));
  // The same through runPreopenGate's own default runner, given only the refusing sandbox.
  const viaDefault = await runPreopenGate(work, { contain: refuse });
  assert.equal(viaDefault.kind, "unmeasured");
  assert.equal(viaDefault.containment, "unmeasured");
});

test("W1-T9619: core and consumer worktrees are both still measured", async () => {
  const consumer = scratch("consumer");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "remudero-console" }));
  for (const work of [coreBuildDir(), consumer]) {
    const harness = scratch("harness");
    const failing = fakeHarnessRmd(harness, { exit: 1, steps: [{ name: "jscpd", ok: false }] });
    const sandbox = contained(fakeSandbox(harness));
    const fail = await runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, failing, undefined, {}, { contain: sandbox }) });
    assert.equal(fail.kind, "fail", `${work}: ${JSON.stringify(fail)}`);
    assert.deepEqual(fail.kind === "fail" ? fail.failedSteps : [], ["jscpd"]);
    assert.match(renderPreopenGatePrompt(fail.kind === "fail" ? fail.failedSteps : [], true), /- jscpd/);
    assert.equal(harnessRan(harness).cwd, work, "the gate runs in the worktree, as data");
    const passing = fakeHarnessRmd(harness, { exit: 0, steps: [] });
    const pass = await runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, passing, undefined, {}, { contain: sandbox }) });
    assert.deepEqual([pass.kind, pass.containment], ["pass", "sandboxed"]);
  }
  assert.deepEqual(preopenGateLedgerFields({ kind: "pass", durationMs: 1 }), {}, "an injected runner records no containment");
});

test("W1-T9619: the sandbox argv binds the harness read-only, masks its git dir and the App key, and lends the slot dir", () => {
  const work = scratch("argv-work");
  const home = scratch("argv-home");
  const harness = scratch("argv-harness");
  mkdirSync(join(harness, ".git"));
  writeFileSync(join(harness, "app-key.pem"), "not a key");
  const slots = scratch("argv-slots");
  const input: GateContainInput = { cwd: work, home, harnessRoot: harness, env: { [TEST_SLOT_DIR_ENV]: slots } };
  const argv = preopenGateSandboxArgv(input, { GH_APP_PRIVATE_KEY_PATH: join(harness, "app-key.pem") });
  const pairs = (flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
  assert.ok(pairs("--ro-bind").includes(harness), "the harness is read-only");
  assert.ok(!pairs("--bind").includes(harness), "the harness is never writable");
  assert.ok(pairs("--bind").includes(work) && pairs("--bind").includes(slots), "the worktree and the slot dir are writable");
  assert.ok(pairs("--tmpfs").includes(join(harness, ".git")), "the harness's git dir is masked");
  assert.ok(argv.indexOf(join(harness, ".git")) > argv.lastIndexOf(harness), "the mask lands on top of the harness bind");
  assert.ok(pairs("--ro-bind").includes("/dev/null") && argv.includes(join(harness, "app-key.pem")), "the App key is masked");
  assert.ok(argv.includes("--unshare-net") && argv.at(-1) === "--", "no network, and the argv ends in --");
  // A harness that is a linked worktree has a .git FILE, masked by /dev/null; no slot dir lends nothing.
  rmSync(join(harness, ".git"), { recursive: true });
  writeFileSync(join(harness, ".git"), "gitdir: /elsewhere\n");
  const linked = preopenGateSandboxArgv({ ...input, env: {} }, {});
  assert.ok(linked.join(" ").includes(`--ro-bind /dev/null ${join(harness, ".git")}`));
  assert.ok(!linked.includes(slots));
});

test("W1-T9619: the default containment names why it cannot contain, and starts the sandbox before it is used", async () => {
  const work = scratch("contain-work");
  const home = scratch("contain-home");
  const harness = scratch("contain-harness");
  const input: GateContainInput = { cwd: work, home, harnessRoot: harness, env: { PATH: process.env.PATH } };
  assert.deepEqual(await defaultGateContainment(input, { platform: "darwin" }), { mode: "unavailable", reason: "bwrap is Linux-only; this darwin host cannot contain the gate" });
  assert.deepEqual(await defaultGateContainment(input, { platform: "linux", binary: join(work, "absent-bwrap") }),
    { mode: "unavailable", reason: `${join(work, "absent-bwrap")} cannot start here (${join(work, "absent-bwrap")} is not installed)` });
  const broken = nodeScript(join(harness, "broken-bwrap"), `process.stderr.write("\\nbwrap: setting up uid map: Permission denied\\n"); process.exit(1);`);
  const refused = await defaultGateContainment(input, { platform: "linux", binary: broken });
  assert.deepEqual(refused, { mode: "unavailable", reason: `${broken} cannot start here (bwrap: setting up uid map: Permission denied)` });
  const nested = join(harness, "worktrees", "w");
  mkdirSync(nested, { recursive: true });
  assert.deepEqual(await defaultGateContainment({ ...input, cwd: nested }, { platform: "linux" }), { mode: "unavailable", reason: "the worktree and the harness checkout overlap" });
  const gone = await defaultGateContainment({ ...input, cwd: join(work, "missing") }, { platform: "linux" });
  assert.match(gone.mode === "unavailable" ? gone.reason : "", /^the sandbox argv could not be built: /);
  const fake = fakeSandbox(harness);
  const started = await defaultGateContainment(input, { platform: "linux", binary: fake });
  assert.equal(started.mode, "sandboxed");
  assert.deepEqual(started.mode === "sandboxed" ? started.argv : [], preopenGateSandboxArgv(input));
  const startArgv = JSON.parse(readFileSync(join(harness, "sandbox-argv.json"), "utf8")) as string[];
  assert.deepEqual(startArgv.slice(-3), [process.execPath, "-e", ""], "the start check runs node -e '' inside the sandbox");
  // The real default, unstubbed: this host either starts bubblewrap or names why not; it never throws.
  const real = await defaultGateContainment(input);
  assert.ok(real.mode === "sandboxed" || /^(bwrap|the) /.test(real.reason), JSON.stringify(real));
});

const bwrapPath = findOnPath("bwrap");
test("W1-T9619: under the real sandbox the gate sees no daemon home, a read-only harness and no network", { skip: bwrapPath === null ? "bwrap is not installed on this host" : false }, async (t) => {
  const work = scratch("real-work");
  const harness = scratch("real-harness");
  mkdirSync(join(harness, "bin"));
  nodeScript(join(harness, "bin", "rmd"),
    `const probe = (f) => { try { f(); return "ok"; } catch (e) { return e.code || String(e.message); } };\n` +
    `const out = { home: process.env.HOME, daemonHome: probe(() => fs.readdirSync(${JSON.stringify(process.env.HOME ?? "/root")})),\n` +
    `  harnessWrite: probe(() => fs.writeFileSync(${JSON.stringify(join(harness, "written"))}, "x")),\n` +
    `  worktreeWrite: probe(() => fs.writeFileSync("written-by-gate", "x")) };\n` +
    `require("net").connect(443, "140.82.112.3").on("error", (e) => { out.net = e.code; fin(); }).on("connect", () => { out.net = "connected"; fin(); });\n` +
    `function fin() { fs.writeFileSync(args[args.indexOf("--summary-file") + 1], JSON.stringify({ ok: true, finishedAt: new Date().toISOString(), steps: [], out })); process.exit(1); }`);
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const contain = await defaultGateContainment({ cwd: work, home: scratch("probe-home"), harnessRoot: harness, env: { PATH: process.env.PATH } });
  if (contain.mode !== "sandboxed") return void t.skip(`bwrap is installed but cannot start here: ${contain.reason}`);
  const result = await runPreopenGate(work, {
    runGate: (cwd) => defaultRunGate(cwd, undefined, (step, extra) => rows.push({ step, extra }), {}, { harnessRoot: harness, readFile: (p) => {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as { out: Record<string, string> };
      assert.equal(parsed.out.daemonHome, "ENOENT", "the daemon's HOME is not in the sandbox");
      assert.equal(parsed.out.harnessWrite, "EROFS", "the harness code is read-only");
      assert.equal(parsed.out.worktreeWrite, "ok", "the worktree is writable");
      assert.notEqual(parsed.out.net, "connected", "the sandbox has no network");
      return JSON.stringify({ ok: false, finishedAt: new Date().toISOString(), steps: [{ name: "probe", ok: false }] });
    } }),
  });
  assert.deepEqual(result.kind === "fail" ? result.failedSteps : result, ["probe"]);
  assert.ok(existsSync(join(work, "written-by-gate")));
  assert.ok(!existsSync(join(harness, "written")));
});

test("W1-T9619: the summary the harness reads lives in its own temp HOME, not the worktree", async () => {
  const work = scratch("summary-work");
  symlinkSync(join(work, "nowhere"), join(work, "coverage"));
  const harness = scratch("summary-harness");
  const rmd = fakeHarnessRmd(harness, { exit: 1, steps: [{ name: "depcruise", ok: false }] });
  const result = await runPreopenGate(work, { runGate: (cwd) => defaultRunGate(cwd, rmd, undefined, {}, { contain: contained(fakeSandbox(harness)) }) });
  assert.deepEqual(result.kind === "fail" ? result.failedSteps : result, ["depcruise"]);
  const summaryArg = harnessRan(harness).argv.at(-1)!;
  assert.ok(summaryArg.endsWith(`/${GATE_SUMMARY_NAME}`) && !summaryArg.startsWith(work), summaryArg);
});
