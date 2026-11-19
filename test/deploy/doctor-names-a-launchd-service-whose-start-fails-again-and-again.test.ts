import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { FIXTURE_CONFIG_PATH_SEGMENTS } from "#src/lib/config.js";
import type { Check, DoctorReport } from "#src/lib/doctor.js";
import { DAEMON_LABEL, DIGEST_LABEL, SERVE_LABEL, SUPERVISOR_LABEL, launchctlGuiTarget, launchdPlistPath } from "#src/lib/launchd.js";
import { doctorCommand, type DoctorDeps } from "#src/lib/report-commands.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const labels = [DAEMON_LABEL, SERVE_LABEL, SUPERVISOR_LABEL, DIGEST_LABEL];
const target = (label: string) => launchctlGuiTarget(process.getuid?.() ?? 0, label);

function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "doctor-launchd").dir;
  const program = join(root, "program");
  const log = join(root, "error.log");
  writeFileSync(program, "", { mode: 0o755 });
  return { root, program, log };
}

function service(label: string, program: string, lines: readonly string[] = []): string {
  return `${target(label)} = {\n\tprogram = ${program}\n${lines.map(line => `\t${line}`).join("\n")}\n}\n`;
}

function writeJobConfig(home: string, root: string, installRoot: string): void {
  const path = join(home, ...FIXTURE_CONFIG_PATH_SEGMENTS);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ claudeBin: "/bin/true", root, installRoot }));
}

function missingService(label: string): never {
  throw Object.assign(new Error("launchctl print failed"), {
    status: 113, stderr: `Bad request.\nCould not find service "${label}" in domain for user gui: 501\n`,
  });
}

async function report(root: string, launchd: NonNullable<DoctorDeps["launchd"]>, installRoot = join(root, "configured install")) {
  const lines: string[] = [];
  const exit = await doctorCommand(["--json"], {
    out: line => lines.push(line),
    loadConfig: () => ({ claudeBin: "/bin/true", root, installRoot }),
    repoRoot: root,
    nowMs: 1_000,
    readLedgerLines: () => [
      { step: "daemon.tick", run_id: "daemon", ts: new Date(1_000).toISOString() },
      { step: "daemon.alive", run_id: "daemon", phase: "dispatch", ts: new Date(1_000).toISOString() },
      { step: "sweep.pass", ts: new Date(1_000).toISOString() },
      { step: "sweep.summary", ts: new Date(1_000).toISOString() },
    ],
    liveInflightRuns: () => [],
    readLockFiles: () => ({ locks: [] }),
    readGitLocks: () => [],
    readMemInfo: () => ({ availableBytes: 1_024, totalBytes: 2_048, swapTotalBytes: 0 }),
    readWorkerProcesses: () => ({ count: 0, processes: [] }),
    readDiskFreeBytes: () => 64 * 1024 ** 3,
    readDiskTotalBytes: () => 128 * 1024 ** 3,
    readCheckoutDepth: () => ({ shallow: false, commitCount: 100_000 }),
    readNvmrcVersion: () => process.versions.node,
    launchd,
  });
  const parsed = JSON.parse(lines.join("\n")) as Pick<DoctorReport, "checks" | "worst">;
  return { ...parsed, exit, launchd: parsed.checks.filter(check => check.name.startsWith("launchd:")) };
}

function checkFor(checks: readonly Check[], label: string): Check {
  const check = checks.find(check => check.name === `launchd:${label}`);
  assert.ok(check, `doctor should report ${label}`);
  return check;
}

test("W1-T12176 criterion 1 reads all four launchd labels and accepts idle jobs", async t => {
  const { root, program } = fixture(t);
  const calls: string[][] = [];
  const result = await report(root, { platform: "darwin", home: root, exec: (cmd, args) => {
    assert.equal(cmd, "launchctl");
    calls.push(args);
    const label = args[1]!.split("/").at(-1)!;
    if (label === DAEMON_LABEL) return service(label, program, ["state = running", "runs = 450", "pid = 17", "last exit code = 127"]);
    if (label === SERVE_LABEL) return service(label, program, ["state = not running", "runs = 3", "last exit code = 127"]);
    if (label === DIGEST_LABEL) return service(label, program, ["state = not running", "runs = 14", "last exit code = 0"]);
    return service(label, program, ["state = not running", "runs = 0", "last exit code = (never exited)"]);
  } });
  assert.deepEqual(calls, labels.map(label => ["print", target(label)]));
  assert.deepEqual(result.launchd.map(check => check.verdict), ["OK", "OK", "OK", "OK"]);
});

test("W1-T12176 criterion 2 fails repeat crashes and bounds the last error line", async t => {
  const { root, program, log } = fixture(t);
  const stderrLink = join(root, "stderr-link.log");
  symlinkSync(log, stderrLink);
  const cause = `${root}/node_modules/.bin/tsx: No such file or directory`;
  writeFileSync(log, Buffer.concat([
    Buffer.from(`${"x".repeat(32_768)}\nprevious failure `),
    Buffer.from([0xff]),
    Buffer.from(`\n${cause} ${"x".repeat(512)} do-not-copy-this-suffix\r\n`),
  ]));
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    if (args[1] !== target(DAEMON_LABEL)) missingService(args[1]!.split("/").at(-1)!);
    return service(DAEMON_LABEL, program, ["state = spawn scheduled", "runs = 450", "last exit code = 127: EX_NOTFOUND", `stderr path = ${stderrLink}`]);
  } });
  const check = checkFor(result.launchd, DAEMON_LABEL);
  assert.equal(check.verdict, "FAIL");
  assert.match(check.measured, /450 starts/);
  assert.ok(check.measured.includes(cause));
  assert.doesNotMatch(check.measured, /previous failure|do-not-copy-this-suffix|\r|\n/);
  assert.ok(check.measured.length < 400);
  assert.equal(result.worst, "FAIL");
  assert.equal(result.exit, 2);
});

test("doctor preserves a crash cause before a long final-line suffix", async t => {
  const { root, program, log } = fixture(t);
  const cause = `${root}/node_modules/.bin/tsx: No such file or directory`;
  writeFileSync(log, `${cause}${" ".repeat(16 * 1024)}`);
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    if (args[1] !== target(DAEMON_LABEL)) missingService(args[1]!.split("/").at(-1)!);
    return service(DAEMON_LABEL, program, ["state = not running", "runs = 4", "last exit code = 1", `stderr path = ${log}`]);
  } });
  const check = checkFor(result.launchd, DAEMON_LABEL);
  assert.equal(check.verdict, "FAIL");
  assert.ok(check.measured.includes(cause));
});

test("W1-T12176 criterion 3 names the missing program and both operator remedies", async t => {
  const { root } = fixture(t);
  const program = join(root, "missing install", "bin", "rmd");
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    if (args[1] !== target(DAEMON_LABEL)) missingService(args[1]!.split("/").at(-1)!);
    return service(DAEMON_LABEL, program, ["state = not running", "runs = 0", "last exit code = (never exited)"]);
  } });
  const check = checkFor(result.launchd, DAEMON_LABEL);
  assert.equal(check.verdict, "FAIL");
  assert.ok(check.measured.includes(program));
  assert.match(check.measured, /install-checkout --write/);
  assert.ok(check.measured.includes(`launchctl bootout ${target(DAEMON_LABEL)}`));
});

test("doctor can decode a bounded tail starting inside an overlong final line", async t => {
  const { root, program, log } = fixture(t);
  writeFileSync(log, `${"é".repeat(10_000)}x`);
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    if (args[1] !== target(DAEMON_LABEL)) missingService(args[1]!.split("/").at(-1)!);
    return service(DAEMON_LABEL, program, ["state = not running", "runs = 4", "last exit code = 1", `stderr path = ${log}`]);
  } });
  const check = checkFor(result.launchd, DAEMON_LABEL);
  assert.equal(check.verdict, "FAIL");
  assert.ok(check.measured.endsWith(`last error: ${"é".repeat(239)}…`));
});

test("W1-T12176 criterion 4 warns about the actual checkout and branch used for self-sync", async t => {
  const { root } = fixture(t);
  const writeLauncher = (checkout: string) => {
    const program = join(checkout, "bin", "rmd");
    mkdirSync(dirname(program), { recursive: true });
    writeFileSync(program, "", { mode: 0o755 });
    return program;
  };
  const main = writeLauncher(gitRepo({ scope: t }).dir);
  const offMain = gitRepo({ scope: t, branch: "plan-amendment" }).dir;
  const offMainProgram = writeLauncher(offMain);
  const jobHome = join(root, "job home");
  writeJobConfig(root, root, dirname(dirname(main)));
  writeJobConfig(jobHome, root, offMain);
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    const label = args[1]!.split("/").at(-1)!;
    const state = ["state = not running", "runs = 4", "last exit code = 0"];
    if (label === SERVE_LABEL) state.push(`working directory = ${offMain}`);
    if (label === DIGEST_LABEL) state.push("environment = {", "\tRMD_SELF_SYNC_DONE => 1", "}");
    if (label === SUPERVISOR_LABEL) state.push(
      "arguments = {", `\t${main}`, "\tdeploy-run", "}",
      "inherited environment = {", `\tHOME => ${root}`, "}",
      "environment = {", `\tHOME => ${jobHome}`, "}",
    );
    return service(label, label === SUPERVISOR_LABEL ? main : offMainProgram, state);
  } }, dirname(dirname(main)));
  const warnings = result.checks.filter(check => check.name.startsWith("launchd-self-sync:"));
  assert.deepEqual(warnings.map(check => [check.name, check.verdict]),
    [[`launchd-self-sync:${SUPERVISOR_LABEL}`, "WARN"]]);
  for (const warning of warnings) {
    assert.ok(warning.measured.includes(offMain));
    assert.ok(warning.measured.includes("plan-amendment"));
  }
});

test("digest self-sync checks the Git checkout at its WorkingDirectory", async t => {
  const { root } = fixture(t);
  const main = gitRepo({ scope: t }).dir;
  const offMain = gitRepo({ scope: t, branch: "digest-plan-amendment" }).dir;
  const nestedWorkingDirectory = join(offMain, "nested", "working-directory");
  mkdirSync(nestedWorkingDirectory, { recursive: true });
  const program = join(main, "bin", "rmd");
  mkdirSync(dirname(program), { recursive: true });
  writeFileSync(program, "", { mode: 0o755 });
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    const label = args[1]!.split("/").at(-1)!;
    if (label === DIGEST_LABEL) return service(label, program, [
      "state = not running", "runs = 4", "last exit code = 0", `working directory = ${nestedWorkingDirectory}`,
    ]);
    if (label === SERVE_LABEL) return service(label, "/bin/true", ["state = not running", "runs = 0", "last exit code = 0"]);
    return missingService(label);
  } });
  const warning = result.checks.find(check => check.name === `launchd-self-sync:${DIGEST_LABEL}`);
  assert.equal(warning?.verdict, "WARN");
  assert.equal(warning.measured, `${realpathSync(offMain)} (digest-plan-amendment)`);
});

test("digest --repo-root resolves nested paths and job environment overrides inherited self-sync guard", async t => {
  const { root } = fixture(t);
  const launcher = gitRepo({ scope: t, branch: "digest-launcher-main" }).dir;
  const offMain = gitRepo({ scope: t, branch: "digest-explicit-root" }).dir;
  const nestedRepoRoot = join(offMain, "src");
  mkdirSync(nestedRepoRoot);
  const program = join(launcher, "bin", "rmd");
  mkdirSync(dirname(program), { recursive: true });
  writeFileSync(program, "", { mode: 0o755 });
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    const label = args[1]!.split("/").at(-1)!;
    if (label === DIGEST_LABEL) return service(label, program, [
      "state = not running", "runs = 4", "last exit code = 0",
      "arguments = {", `\t${program}`, "\t--repo-root", `\t${nestedRepoRoot}`, "}",
      "inherited environment = {", "\tRMD_SELF_SYNC_DONE => 1", "}",
      "environment = {", "\tRMD_SELF_SYNC_DONE => 0", "}",
    ]);
    return missingService(label);
  } });
  const warning = result.checks.find(check => check.name === `launchd-self-sync:${DIGEST_LABEL}`);
  assert.equal(warning?.verdict, "WARN");
  assert.equal(warning?.measured, `${realpathSync(offMain)} (digest-explicit-root)`);
});

test("digest self-sync falls back to the launcher checkout when WorkingDirectory is outside Git", async t => {
  const { root } = fixture(t);
  const launcher = gitRepo({ scope: t, branch: "digest-launcher-branch" }).dir;
  const program = join(launcher, "bin", "rmd");
  mkdirSync(dirname(program), { recursive: true });
  writeFileSync(program, "", { mode: 0o755 });
  const stateRoot = join(root, "state outside git");
  mkdirSync(stateRoot);
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    const label = args[1]!.split("/").at(-1)!;
    if (label === DIGEST_LABEL) return service(label, program, [
      "state = not running", "runs = 4", "last exit code = 0", `working directory = ${stateRoot}`,
    ]);
    return missingService(label);
  } });
  const warning = result.checks.find(check => check.name === `launchd-self-sync:${DIGEST_LABEL}`);
  assert.equal(warning?.verdict, "WARN");
  assert.equal(warning.measured, `${realpathSync(launcher)} (digest-launcher-branch)`);
  assert.equal(result.checks.some(check => check.name === `launchd-self-sync:${SERVE_LABEL}`), false);
});

test("digest self-sync uses the launcher checkout when WorkingDirectory is omitted", async t => {
  const { root } = fixture(t);
  const launcher = gitRepo({ scope: t, branch: "digest-default-cwd-branch" }).dir;
  const program = join(launcher, "bin", "rmd");
  mkdirSync(dirname(program), { recursive: true });
  writeFileSync(program, "", { mode: 0o755 });
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    const label = args[1]!.split("/").at(-1)!;
    if (label === DIGEST_LABEL) return service(label, program, [
      "state = not running", "runs = 4", "last exit code = 0",
    ]);
    return missingService(label);
  } });
  const warning = result.checks.find(check => check.name === `launchd-self-sync:${DIGEST_LABEL}`);
  assert.equal(warning?.verdict, "WARN");
  assert.equal(warning?.measured, `${realpathSync(launcher)} (digest-default-cwd-branch)`);
});

test("supervisor --state-root overrides its job HOME's explicit install checkout", async t => {
  const { root, program } = fixture(t);
  const configured = gitRepo({ scope: t }).dir;
  const jobHome = join(root, "job home");
  writeJobConfig(jobHome, root, configured);
  const stateRoot = join(root, "other state root");
  mkdirSync(stateRoot);
  const checkout = join(stateRoot, "daemon-install");
  symlinkSync(gitRepo({ scope: t, branch: "override-branch" }).dir, checkout, "dir");
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    if (args[1] !== target(SUPERVISOR_LABEL)) missingService(args[1]!.split("/").at(-1)!);
    return service(SUPERVISOR_LABEL, program, [
      "state = not running", "runs = 4", "last exit code = 0",
      "arguments = {", `\t${program}`, "\tdeploy-run", "\t--state-root", `\t${stateRoot}`, "}",
      "environment = {", `\tHOME => ${jobHome}`, "}",
    ]);
  } }, configured);
  const warning = result.checks.find(check => check.name === `launchd-self-sync:${SUPERVISOR_LABEL}`);
  assert.equal(warning?.verdict, "WARN");
  assert.equal(warning.measured, `${checkout} (override-branch)`);
});

test("doctor reports an unreadable supervisor checkout without creating a job config", async t => {
  const { root, program } = fixture(t);
  const jobHome = join(root, "unconfigured home");
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    if (args[1] !== target(SUPERVISOR_LABEL)) missingService(args[1]!.split("/").at(-1)!);
    return service(SUPERVISOR_LABEL, program, [
      "state = not running", "runs = 4", "last exit code = 0",
      "arguments = {", `\t${program}`, "\tdeploy-run", "}",
      "environment = {", `\tHOME => ${jobHome}`, "}",
    ]);
  } }, gitRepo({ scope: t }).dir);
  assert.equal(checkFor(result.launchd, SUPERVISOR_LABEL).verdict, "OK");
  const warning = result.checks.find(check => check.name === `launchd-self-sync:${SUPERVISOR_LABEL}`);
  assert.equal(warning?.verdict, "WARN");
  assert.match(warning.measured, /checkout unreadable/);
  assert.equal(existsSync(jobHome), false);
});

test("W1-T12176 criterion 5 distinguishes absent, unreadable, and non-launchd hosts", async t => {
  const { root } = fixture(t);
  const plist = launchdPlistPath(SUPERVISOR_LABEL, root);
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, "");
  const linux = await report(root, { platform: "linux", exec: () => assert.fail("launchctl must not run on Linux") });
  assert.deepEqual(linux.launchd, []);
  const mac = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    if (args[1] === target(SERVE_LABEL)) throw Object.assign(new Error("permission denied"), { status: 1 });
    if (args[1] === target(DIGEST_LABEL)) return service(DIGEST_LABEL, "/bin/true", ["state = not running", "runs = 450"]);
    return missingService(args[1]!.split("/").at(-1)!);
  } });
  assert.deepEqual(mac.launchd.map(check => check.name), [SERVE_LABEL, SUPERVISOR_LABEL, DIGEST_LABEL].map(label => `launchd:${label}`));
  for (const check of mac.launchd) {
    assert.equal(check.verdict, "WARN");
    assert.match(check.measured, /unreadable/);
  }
});

test("doctor keeps repeated crash evidence when the service has no readable error log", async t => {
  const { root, program, log } = fixture(t);
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    if (args[1] !== target(DAEMON_LABEL)) missingService(args[1]!.split("/").at(-1)!);
    return service(DAEMON_LABEL, program, ["state = not running", "runs = 4", "last exit code = 1", `stderr path = ${log}`]);
  } });
  const check = checkFor(result.launchd, DAEMON_LABEL);
  assert.equal(check.verdict, "FAIL");
  assert.match(check.measured, /error log unavailable/);
});

test("doctor describes a prior signal separately and reports an unreadable program path", async t => {
  const { root } = fixture(t);
  const program = join(root, "program-loop");
  symlinkSync(program, program);
  const result = await report(root, { platform: "darwin", home: root, exec: (_cmd, args) => {
    if (args[1] !== target(DAEMON_LABEL)) missingService(args[1]!.split("/").at(-1)!);
    return service(DAEMON_LABEL, program, ["state = running", "runs = 4", "pid = 18", "last terminating signal = Killed: 9"]);
  } });
  const check = checkFor(result.launchd, DAEMON_LABEL);
  assert.equal(check.verdict, "WARN");
  assert.match(check.measured, /pid 18, last signal Killed: 9/);
  assert.ok(check.measured.includes(`program path unreadable: ${program}`));
});

test("doctor treats an unavailable launchctl executable as unreadable on Darwin", async t => {
  const { root } = fixture(t);
  const originalPath = process.env.PATH;
  process.env.PATH = root;
  try {
    const result = await report(root, { platform: "darwin", home: root });
    assert.deepEqual(result.launchd.map(check => [check.verdict, check.measured]),
      labels.map(() => ["WARN", "unreadable (launchctl print failed)"]));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
