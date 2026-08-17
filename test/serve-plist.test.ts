/**
 * test/serve-plist.test.ts — W1-T152: the operator console as a launchd SERVICE.
 *
 * Its own file, not an append to test/run-task.test.ts: that file crashes at the FILE level
 * under `--experimental-test-coverage` (a node test-runner v8 report-channel flake), which
 * zeroes the coverage record for everything in it — a coverage-load-bearing test must never
 * live there.
 *
 * Every assertion below is over a PURE function or an injected fake. No launchd, no live
 * server, no port. Commissioning the real unit is the operator's step (the W1-T12d boundary
 * every generator in this family keeps).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DAEMON_LABEL,
  DEFAULT_LAUNCHD_PATH,
  DEFAULT_SERVE_THROTTLE_S,
  LaunchdPlistError,
  SERVE_LABEL,
  SERVE_WILDCARD_HOSTS,
  generateServeLaunchdPlist,
  launchdPlistPath,
  serveLogPaths,
} from "../src/lib/launchd.js";
import {
  DEFAULT_SERVE_PORT,
  SERVE_EXPECTED_BRANCH,
  WILDCARD_HOSTS,
  currentBranch,
  ensureLogFileMode,
  listenWithReapWait,
  offMainNotice,
  resolveServeHosts,
  resolveServePort,
} from "../src/lib/serve.js";
import { main, servePlistCommand } from "../src/run-task.js";
import { SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";

const VALID = {
  rmdBin: "/Users/op/Remudero/daemon-install/bin/rmd",
  installRoot: "/Users/op/Remudero/daemon-install",
  installRootExists: true,
  root: "/Users/op/Remudero",
  port: 4317,
  hosts: ["127.0.0.1", "100.90.47.107"],
};

/** The EnvironmentVariables dict, isolated — several assertions are about what is NOT in it. */
function envBlock(plist: string): string {
  return plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
}

// ── The generated unit ────────────────────────────────────────────────────────────────────

test("the serve unit runs `rmd serve` as a KeepAlive background service with the port baked in", () => {
  const plist = generateServeLaunchdPlist(VALID);
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.remudero\.serve<\/string>/);
  assert.equal(SERVE_LABEL, "com.remudero.serve");
  const args = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
  assert.deepEqual(
    [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]),
    [VALID.rmdBin, "serve", "--port", "4317"],
    "ProgramArguments is the absolute launcher + serve + the resolved port — launchd execs argv[0] directly",
  );
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/op\/Remudero<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test("KeepAlive is UNCONDITIONAL, not the daemon's SuccessfulExit:false — serve exits 0 on a clean SIGTERM", () => {
  const plist = generateServeLaunchdPlist(VALID);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.doesNotMatch(
    plist,
    /<key>SuccessfulExit<\/key>/,
    "SuccessfulExit:false would leave the console DOWN after the exact ctrl+C this task exists to survive",
  );
});

test("ThrottleInterval is explicit (R-1: 438 relaunches in two days with KeepAlive and no rate limit)", () => {
  assert.match(generateServeLaunchdPlist(VALID), new RegExp(`<key>ThrottleInterval</key>\\s*<integer>${DEFAULT_SERVE_THROTTLE_S}</integer>`));
  assert.equal(DEFAULT_SERVE_THROTTLE_S, 60);
  assert.match(generateServeLaunchdPlist({ ...VALID, throttleSeconds: 30 }), /<integer>30<\/integer>/);
});

test("a throttle under 10s is refused — that is the relaunch storm, re-armed", () => {
  assert.throws(() => generateServeLaunchdPlist({ ...VALID, throttleSeconds: 5 }), LaunchdPlistError);
  assert.throws(() => generateServeLaunchdPlist({ ...VALID, throttleSeconds: 60.5 }), LaunchdPlistError);
});

test("the resolved bind list rides in RMD_SERVE_HOST, alongside a closed PATH+HOME allowlist", () => {
  const plist = generateServeLaunchdPlist({ ...VALID, home: "/Users/op" });
  const block = envBlock(plist);
  assert.match(block, /<key>RMD_SERVE_HOST<\/key>\s*<string>127\.0\.0\.1,100\.90\.47\.107<\/string>/);
  assert.match(block, /<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin[^<]*<\/string>/);
  assert.match(block, /<key>HOME<\/key>\s*<string>\/Users\/op<\/string>/);
  assert.deepEqual(
    [...block.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1]).sort(),
    ["HOME", "PATH", "RMD_SERVE_HOST"],
    "a CLOSED allowlist: launchd never sources ~/.zshrc, so this dict is the WHOLE boot env",
  );
  assert.equal(DEFAULT_LAUNCHD_PATH.includes("/usr/local/bin"), true);
});

test("the unit embeds NO token — service-tokens.json is read at boot, as today", () => {
  const plist = generateServeLaunchdPlist(VALID);
  const block = envBlock(plist);
  assert.doesNotMatch(block, /ANTHROPIC_/i, "the billing boundary: no ANTHROPIC_* key can reach a generated unit");
  assert.doesNotMatch(block, /TOKEN|SECRET|KEY<\/key>/i, "no secret at rest in a plist that lives in ~/Library/LaunchAgents");
  assert.match(plist, /service-tokens\.json/, "the unit documents WHERE the tokens come from instead of carrying them");
});

test("logs land in the state/logs home this family uses, one file per stream", () => {
  const plist = generateServeLaunchdPlist(VALID);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/op\/Remudero\/state\/logs\/serve\.out\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/op\/Remudero\/state\/logs\/serve\.err\.log<\/string>/);
  assert.deepEqual(serveLogPaths("/Users/op/Remudero"), {
    stdout: "/Users/op/Remudero/state/logs/serve.out.log",
    stderr: "/Users/op/Remudero/state/logs/serve.err.log",
  });
});

test("DAEMON-INDEPENDENCE: the serve unit names no daemon label, subcommand, or daemon-specific log path", () => {
  const plist = generateServeLaunchdPlist(VALID);
  assert.doesNotMatch(plist, new RegExp(DAEMON_LABEL.replace(/\./g, "\\.")));
  // The invariant is about what launchd EXECUTES and what STATE it depends on, not about
  // whether the two units' launcher binary happens to live under a shared install checkout
  // whose directory name mentions "daemon" — W1-T925 has ALL FOUR units (daemon, serve,
  // digest, supervisor) share ONE install root by design (`resolveInstallRoot`'s own default
  // is `<root>/daemon-install`, lib/install-root.ts), so a blanket "no /daemon/i anywhere"
  // check would now false-positive on that shared, INTENTIONAL path — not a real coupling.
  // Strip the XML comments (which legitimately cite the daemon generator this one is modelled
  // on) and assert the directives name no daemon LABEL, no `daemon` SUBCOMMAND, and no
  // daemon-specific LOG path — the concrete ways a stopped daemon could blind the console.
  const directives = plist.replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(directives, new RegExp(DAEMON_LABEL.replace(/\./g, "\\.")), "never the daemon's own label");
  assert.doesNotMatch(directives, /<string>daemon<\/string>/, "never runs `rmd daemon`");
  assert.doesNotMatch(
    directives,
    /daemon\.(out|err)\.log/,
    "stopping the fleet for containment must never blind the operator's board",
  );
  assert.equal(launchdPlistPath(SERVE_LABEL, "/Users/op"), "/Users/op/Library/LaunchAgents/com.remudero.serve.plist");
  assert.notEqual(launchdPlistPath(SERVE_LABEL, "/Users/op"), launchdPlistPath(DAEMON_LABEL, "/Users/op"));
});

test("relative paths and out-of-range ports are refused at GENERATION — the cheapest layer", () => {
  assert.throws(() => generateServeLaunchdPlist({ ...VALID, rmdBin: "bin/rmd" }), LaunchdPlistError);
  assert.throws(() => generateServeLaunchdPlist({ ...VALID, root: "Remudero" }), LaunchdPlistError);
  assert.throws(() => generateServeLaunchdPlist({ ...VALID, home: "op" }), LaunchdPlistError);
  assert.throws(() => generateServeLaunchdPlist({ ...VALID, port: 0 }), LaunchdPlistError);
  assert.throws(() => generateServeLaunchdPlist({ ...VALID, port: 70000 }), LaunchdPlistError);
  assert.throws(() => generateServeLaunchdPlist({ ...VALID, port: 4317.5 }), LaunchdPlistError);
});

// ── W1-T925 (fb-1784913390318-1fcb63): the serve unit's binary comes from the install
// checkout too — SAME gates generateLaunchdPlist applies to the daemon unit, reused rather
// than reimplemented (this generator family's own header, lib/launchd.ts). ──────────────────

test("generateServeLaunchdPlist: refuses when rmdBin resolves OUTSIDE installRoot, naming the remedy", () => {
  assert.throws(
    () => generateServeLaunchdPlist({ ...VALID, rmdBin: "/Users/op/some-operator-checkout/bin/rmd" }),
    (e: unknown) =>
      e instanceof LaunchdPlistError &&
      /OUTSIDE the install root/.test((e as Error).message) &&
      /rmd install-checkout --write/.test((e as Error).message),
    "no plist string is ever returned for a binary path outside the install checkout",
  );
});

test("generateServeLaunchdPlist: refuses when the install checkout does not exist, naming the remedy", () => {
  assert.throws(
    () => generateServeLaunchdPlist({ ...VALID, installRootExists: false }),
    (e: unknown) =>
      e instanceof LaunchdPlistError &&
      /install checkout does not exist/.test((e as Error).message) &&
      /rmd install-checkout --write/.test((e as Error).message),
    "never emits a unit whose ProgramArguments[0] would be a missing binary",
  );
});

test("generateServeLaunchdPlist embeds the SAME install-derived rmdBin the daemon/digest/supervisor units do, given the same {rmdBin, installRoot} (acceptance criterion 3)", () => {
  const shared = { rmdBin: "/Users/op/Remudero/daemon-install/bin/rmd", installRoot: "/Users/op/Remudero/daemon-install", installRootExists: true };
  const plist = generateServeLaunchdPlist({ ...VALID, ...shared });
  assert.match(plist, new RegExp(`<string>${shared.rmdBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
});

test("a wildcard bind is refused, and the refusal set cannot drift from serve.ts's own", () => {
  for (const wildcard of WILDCARD_HOSTS) {
    assert.throws(
      () => generateServeLaunchdPlist({ ...VALID, hosts: ["127.0.0.1", wildcard] }),
      (e: unknown) => e instanceof LaunchdPlistError && /EVERY interface/.test((e as Error).message),
      `host ${JSON.stringify(wildcard)} must be refused — a launchd unit makes the exposure permanent`,
    );
  }
  assert.deepEqual(
    [...SERVE_WILDCARD_HOSTS].sort(),
    [...WILDCARD_HOSTS].sort(),
    "the generator's defense-in-depth copy and serve.ts's primary gate are the SAME set",
  );
  assert.throws(() => generateServeLaunchdPlist({ ...VALID, hosts: [] }), LaunchdPlistError);
});

// ── Resolution: flag > env > config > default, one answer for the unit and for a hand-run ──

test("resolveServePort falls back to the config port, and rejects garbage from EITHER source", () => {
  assert.equal(resolveServePort([], undefined), DEFAULT_SERVE_PORT);
  assert.equal(resolveServePort([], 4400), 4400, "config serve.port is used when no flag is given");
  assert.equal(resolveServePort(["--port", "4500"], 4400), 4500, "the flag outranks config");
  assert.throws(() => resolveServePort([], 99999), /config serve\.port/);
  assert.throws(() => resolveServePort(["--port", "abc"], 4400), /--port/);
});

test("resolveServeHosts falls back to the config host — env still outranks it, flag outranks both", () => {
  assert.deepEqual(resolveServeHosts([], {}, "127.0.0.1,100.90.47.107"), ["127.0.0.1", "100.90.47.107"]);
  assert.deepEqual(resolveServeHosts([], { RMD_SERVE_HOST: "10.0.0.9" }, "127.0.0.1"), ["10.0.0.9"]);
  assert.deepEqual(resolveServeHosts(["--host", "10.0.0.1"], { RMD_SERVE_HOST: "10.0.0.9" }, "127.0.0.1"), ["10.0.0.1"]);
  assert.deepEqual(resolveServeHosts([], {}, undefined), ["127.0.0.1"], "absent everywhere: loopback, exactly as before");
  assert.throws(() => resolveServeHosts([], {}, "0.0.0.0"), /EVERY interface/, "a config wildcard is refused too");
});

// ── The three service-lifecycle behaviours ────────────────────────────────────────────────

test("listenWithReapWait WAITS OUT a port the dying process still holds, then binds", async () => {
  const waits: number[] = [];
  const retries: number[] = [];
  let calls = 0;
  await listenWithReapWait(
    async () => {
      calls++;
      if (calls <= 3) throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    },
    { delayMs: 500, sleep: async (ms) => void waits.push(ms), onRetry: (n) => void retries.push(n) },
  );
  assert.equal(calls, 4, "three losing attempts, then the bind succeeds — no silent EADDRINUSE death");
  assert.deepEqual(waits, [500, 500, 500]);
  assert.deepEqual(retries, [1, 2, 3], "every wait is AUDIBLE — the original outage was silent");
});

test("listenWithReapWait rethrows a NON-EADDRINUSE listen error immediately", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      listenWithReapWait(
        async () => {
          calls++;
          throw Object.assign(new Error("listen EADDRNOTAVAIL 100.90.47.107"), { code: "EADDRNOTAVAIL" });
        },
        { sleep: async () => {} },
      ),
    /EADDRNOTAVAIL/,
  );
  assert.equal(calls, 1, "a tailnet address that is not up yet needs a diagnosis, not 20 retries");
});

test("listenWithReapWait gives up after its bounded window rather than waiting forever", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      listenWithReapWait(
        async () => {
          calls++;
          throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
        },
        { attempts: 4, sleep: async () => {} },
      ),
    /EADDRINUSE/,
  );
  assert.equal(calls, 4, "a genuinely stuck port surfaces as a real error inside the ThrottleInterval");
});

test("ensureLogFileMode creates the console's logs 0600 and TIGHTENS one launchd already made 0644", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-servelog-"));
  const logs = serveLogPaths(root);
  const created = ensureLogFileMode([logs.stdout, logs.stderr]);
  assert.deepEqual(created.failed, []);
  assert.deepEqual(created.secured.sort(), [logs.stderr, logs.stdout].sort());
  assert.equal(statSync(logs.stdout).mode & 0o777, 0o600, "the banner prints a bearer token — the log is not world-readable");
  assert.equal(statSync(logs.stderr).mode & 0o777, 0o600);

  chmodSync(logs.stdout, 0o644); // exactly what launchd's own umask produces (R-5)
  writeFileSync(logs.stdout, "existing content\n");
  ensureLogFileMode([logs.stdout]);
  assert.equal(statSync(logs.stdout).mode & 0o777, 0o600, "boot REPAIRS a file launchd got to first");
  assert.equal(readFileSync(logs.stdout, "utf8"), "existing content\n", "and never truncates the log to do it");
});

test("ensureLogFileMode NEVER throws — a hygiene failure must not become an outage", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-servelog-bad-"));
  const wall = join(root, "not-a-dir");
  writeFileSync(wall, "");
  const result = ensureLogFileMode([join(wall, "serve.out.log")]);
  assert.deepEqual(result.secured, []);
  assert.equal(result.failed.length, 1, "the failure is REPORTED (the caller ledgers it) rather than thrown");
});

test("offMainNotice: off-main is SAID loudly and served anyway (W1-T255 — a service never exit-1s)", () => {
  const notice = offMainNotice("run-W1-T152");
  assert.notEqual(notice, null);
  assert.match(notice as string, /run-W1-T152/, "the branch is NAMED — the operator must know what he is looking at");
  assert.match(notice as string, /Serving anyway/, "it is a notice, not a refusal: KeepAlive turns a refusal into a crash-loop");
  assert.match(notice as string, /kickstart -k/, "and it hands over the one command that fixes it");
  assert.equal(offMainNotice(SERVE_EXPECTED_BRANCH), null, "on main: silent");
  assert.equal(offMainNotice(null), null, "an unreadable branch is 'don't know', never 'off main' — no crying wolf");
});

test("currentBranch reads the checkout's branch, and answers null rather than guessing", () => {
  assert.equal(currentBranch("/repo", () => "main\n"), "main");
  assert.equal(currentBranch("/repo", () => "run-W1-T152\n"), "run-W1-T152");
  assert.equal(currentBranch("/repo", () => "HEAD\n"), null, "detached HEAD is not a branch");
  assert.equal(currentBranch("/repo", () => ""), null);
  assert.equal(
    currentBranch("/repo", () => {
      throw new Error("not a git repository");
    }),
    null,
  );
  // The DEFAULT runner is the real git read — exercised here against this very checkout.
  // Normalized, not raw: CI checks out a detached merge SHA, where `rev-parse --abbrev-ref
  // HEAD` answers the literal "HEAD" and this function is REQUIRED to report null ("don't
  // know") rather than treat a detached checkout as a branch named HEAD and warn about it.
  const raw = execFileSync("git", ["-C", process.cwd(), "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(
    currentBranch(process.cwd()),
    raw === "HEAD" || raw === "" ? null : raw,
    "the default runner is the real git read, not only the injected fake",
  );
});

// ── The CLI edge: what the operator actually runs ─────────────────────────────────────────

/** A throwaway HOME whose config.json is the one loadConfig() will read. ALSO provisions the
 *  default install root (W1-T924's `resolveInstallRoot`: `<root>/daemon-install`, unset
 *  `config.installRoot`) with a stub `bin/rmd`, so `generateServeLaunchdPlist`'s W1-T925
 *  install-checkout-exists gate does not refuse these CLI-level fixtures — the same real
 *  provisioning step `rmd install-checkout --write` performs, stood up by hand here since
 *  these tests never shell out to git. */
function servePlistTestHome(serve?: { host?: string; port?: number }): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-serveplist-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root, serve }));
  mkdirSync(join(root, "daemon-install", "bin"), { recursive: true });
  writeFileSync(join(root, "daemon-install", "bin", "rmd"), "#!/bin/sh\nexit 0\n");
  return { home, root };
}

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.HOME;
    else process.env.HOME = old;
  }
}

test("servePlistCommand --write installs the unit AND pre-creates both logs 0600", async () => {
  const { home, root } = servePlistTestHome({ host: "127.0.0.1,100.90.47.107", port: 4317 });
  const oldEnvHost = process.env.RMD_SERVE_HOST;
  delete process.env.RMD_SERVE_HOST; // config is the source under test here
  try {
    const rc = await withHome(home, () => servePlistCommand(["--write"]));
    assert.equal(rc, 0);
    const plistPath = join(home, "Library", "LaunchAgents", "com.remudero.serve.plist");
    assert.equal(existsSync(plistPath), true, "the unit is written where launchctl bootstrap will find it");
    const plist = readFileSync(plistPath, "utf8");
    assert.match(plist, /<string>127\.0\.0\.1,100\.90\.47\.107<\/string>/, "the CONFIG-declared bind list reached the unit");
    assert.match(plist, /<string>4317<\/string>/);
    assert.match(plist, /bin\/rmd<\/string>/);
    const logs = serveLogPaths(root);
    assert.equal(statSync(logs.stdout).mode & 0o777, 0o600, "pre-created 0600 BEFORE launchd can create them 0644");
    assert.equal(statSync(logs.stderr).mode & 0o777, 0o600);
  } finally {
    if (oldEnvHost !== undefined) process.env.RMD_SERVE_HOST = oldEnvHost;
  }
});

test("servePlistCommand without --write prints the unit and writes NOTHING", async () => {
  const { home, root } = servePlistTestHome();
  const printed: string[] = [];
  const oldLog = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.join(" "));
  let rc: number;
  try {
    rc = await withHome(home, () => servePlistCommand([]));
  } finally {
    console.log = oldLog;
  }
  assert.equal(rc, 0);
  assert.equal(existsSync(join(home, "Library", "LaunchAgents", "com.remudero.serve.plist")), false);
  assert.equal(existsSync(serveLogPaths(root).stdout), false, "a dry print creates no files at all");
  const out = printed.join("\n");
  assert.match(out, /<key>Label<\/key>\s*<string>com\.remudero\.serve<\/string>/);
  assert.match(out, /launchctl bootstrap gui\/\$UID/, "the operator's commissioning line is printed, never run");
  assert.match(out, /launchctl kickstart -k gui\/\$UID\/com\.remudero\.serve/);
});

/** `process.exit` is how main() returns — thrown so the test can observe the code. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

test("main(): `rmd serve-plist` actually ROUTES to servePlistCommand and exits with its code", async (t) => {
  t.mock.method(process, "exit", ((code?: number): never => {
    throw new ExitCalled(code);
  }) as typeof process.exit);
  const logSpy = t.mock.method(console, "log", () => {});
  const { home } = servePlistTestHome({ host: "127.0.0.1,100.90.47.107" });
  const originalArgv = process.argv;
  const originalGuard = process.env[SELF_SYNC_GUARD_ENV];
  const oldEnvHost = process.env.RMD_SERVE_HOST;
  process.argv = ["node", "run-task.js", "serve-plist"];
  process.env[SELF_SYNC_GUARD_ENV] = "1"; // no self-sync fetch/re-exec inside a test
  delete process.env.RMD_SERVE_HOST;
  try {
    let caught: unknown;
    await withHome(home, () =>
      main().catch((e) => {
        caught = e;
      }),
    );
    assert.ok(caught instanceof ExitCalled, "a registered command that main() does not route is a command that does not exist");
    assert.equal((caught as ExitCalled).code, 0);
    const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
    assert.match(printed, /<string>com\.remudero\.serve<\/string>/);
    assert.match(printed, /<string>127\.0\.0\.1,100\.90\.47\.107<\/string>/);
  } finally {
    process.argv = originalArgv;
    if (originalGuard === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = originalGuard;
    if (oldEnvHost !== undefined) process.env.RMD_SERVE_HOST = oldEnvHost;
  }
});

test("servePlistCommand rejects an unknown flag and a bad port before generating anything", async () => {
  const { home } = servePlistTestHome();
  const oldErr = console.error;
  console.error = () => {};
  try {
    assert.equal(await withHome(home, () => servePlistCommand(["--repo", "remudero"])), 2);
    assert.equal(await withHome(home, () => servePlistCommand(["--port", "banana"])), 2);
    assert.equal(await withHome(home, () => servePlistCommand(["--host", "0.0.0.0"])), 2, "a wildcard never reaches a unit");
  } finally {
    console.error = oldErr;
  }
});
