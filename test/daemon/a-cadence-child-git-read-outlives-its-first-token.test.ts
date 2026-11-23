// W1-T14537: a measurement cadence child minted its App token at 16:58:05Z (expiring 17:58:05Z), then spent a long
// synchronous stretch in which its refresh timer could not fire. A sync `git fetch` of the private ops checkout inside
// that stretch asked the container's global credential helper, which reads GH_TOKEN from git's env, and presented the
// expired value: "Invalid username or token". The child's git now asks the daemon's git credential socket when git
// calls the helper, and a refresh that runs after the token it replaces expired writes a row saying how late it was.
//
// FIXTURES ONLY: the daemon's real socket (`startDaemonGitCredentialSocket`) serving a fixture mint in-process, a local
// HTTP server standing in for GitHub that accepts one Basic credential, a fixture global gitconfig carrying
// deploy/entrypoint.sh's helper verbatim, and a fake spawn that captures what the daemon hands the child. No network.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { refreshInstallationToken, startInstallationTokenRefresh, type RefreshOptions, type RefreshResult } from "#src/lib/github-app.js";
// Namespace import: the new exports read undefined at base, so each test fails on its own assertion.
import * as cadence from "#src/lib/measurement-cadence.js";
import { startDaemonGitCredentialSocket, type ScopedTokenMint } from "#src/lib/secret-boundary.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const LATE_STEP = "github_app.token_refresh_late";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const T0 = Date.parse("2026-11-23T16:58:05.000Z");
/** deploy/entrypoint.sh's helper, verbatim: it reads GH_TOKEN from git's env when git calls it. */
const ENTRYPOINT_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
const OPS_PATH = "/craigoley/remudero-ops.git";

const secret = (label: string): string => `${label}-${randomBytes(12).toString("hex")}`;

interface Launch { file: string; argv: string[]; env: NodeJS.ProcessEnv }

/** What the daemon would hand a cadence child: the real spawn, with only the process launch captured. */
function launchChild(t: TestContext, opts: { root: string; env: NodeJS.ProcessEnv }): Launch {
  const launched: Launch[] = [];
  const fakeSpawn = ((file: string, argv: string[], o: { env: NodeJS.ProcessEnv }) => {
    launched.push({ file, argv, env: o.env });
    return { pid: 4242, unref: () => {}, once: () => {} };
  }) as unknown as typeof spawn;
  const statePath = join(ownedFixtureDir(t, "t14537-state").dir, "measurement-cadence-child.json");
  cadence.childMeasurementCadenceSpawn({
    entry: "measurement-cadence-child.ts", execArgv: [], env: opts.env, config: { root: opts.root, claudeBin: "/bin/true" } as Config,
    spawnChild: fakeSpawn, setPriority: () => {},
  })("MEASUREMENT-CADENCE-CHILD-1795453075106", statePath);
  assert.equal(launched.length, 1, "the daemon launched one child");
  return launched[0]!;
}

/** A local stand-in for GitHub's smart-HTTP endpoint: 401 until it is shown `x-access-token:<accepted>`. */
async function privateRemote(t: TestContext, accepted: string): Promise<{ url: string; presented: string[] }> {
  const presented: string[] = [];
  const want = `Basic ${Buffer.from(`x-access-token:${accepted}`).toString("base64")}`;
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth) presented.push(Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8"));
    if (auth !== want) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      res.end();
      return;
    }
    // An empty dumb-HTTP listing: a repository with no refs, so the authorized fetch succeeds with nothing to fetch.
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}${OPS_PATH}`, presented };
}

/** The child's environment as the container gives it: a global gitconfig with the entrypoint helper, no system file. */
function containerEnv(t: TestContext, ghToken: string): NodeJS.ProcessEnv {
  const home = ownedFixtureDir(t, "t14537-home").dir;
  const globalConfig = join(home, ".gitconfig");
  execFileSync("git", ["config", "--file", globalConfig, "credential.helper", ENTRYPOINT_HELPER]);
  return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0", GH_TOKEN: ghToken };
}

/** `git -C <ops> fetch origin --quiet`, the command that failed, run as the child's git would run it. */
function fetchAsChild(dir: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("git", ["-C", dir, "fetch", "origin", "--quiet"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

/** The daemon's own git credential socket, minting `fresh` for each request, its rows captured. */
async function daemonSocket(t: TestContext, root: string, fresh: string) {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const mints: string[] = [];
  const mint: ScopedTokenMint = async (repo) => {
    mints.push(repo);
    return { ok: true, token: fresh, expiresAtMs: Date.now() + 10 * MINUTE_MS };
  };
  const socket = await startDaemonGitCredentialSocket({ ready: Promise.resolve(), stateDir: join(root, "state"), log: (step, fields) => rows.push({ step, fields }), mint });
  assert.ok(socket, "the daemon's socket started");
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await socket.close();
  };
  t.after(close);
  return { socketPath: socket.socketPath, rows, mints, close };
}

/** A fixture checkout whose origin is the private remote, as the ops checkout's is. */
function opsTree(url: string): string {
  const checkout = gitRepo({ kind: "t14537-ops" });
  checkout.addRemote("origin", url);
  return checkout.dir;
}

test("W1-T14537 criterion 1: a child whose GH_TOKEN expired still fetches the private repository, with the socket's call-time credential", async (t) => {
  assert.equal(typeof cadence.measurementCadenceChildGitCredentialEnv, "function", "the spawn builds the child's git credential wiring");
  const stale = secret("expired-env-token");
  const fresh = secret("socket-minted-token");
  const root = ownedFixtureDir(t, "t14537-root").dir;
  const remote = await privateRemote(t, fresh);
  const dir = opsTree(remote.url);
  const env = containerEnv(t, stale);

  // Control: the env path alone presents the expired token and fails, as it did at 18:07:18Z.
  const control = await fetchAsChild(dir, env);
  assert.notEqual(control.code, 0, "the control fetch with only the env helper fails");
  assert.match(control.stderr, /Authentication failed/, "the control failure is an authentication failure");
  assert.deepEqual(remote.presented, [`x-access-token:${stale}`], "the control fetch presented the expired env token");

  const socket = await daemonSocket(t, root, fresh);
  const launch = launchChild(t, { root, env });
  assert.equal(launch.env.GH_TOKEN, stale, "the child still holds the expired env value; nothing refreshed it");
  remote.presented.length = 0;
  const fetched = await fetchAsChild(dir, launch.env);
  assert.equal(fetched.code, 0, `the child's fetch authenticates: ${fetched.stderr}`);
  assert.ok(remote.presented.length >= 1, "the authorized fetch presented a credential");
  assert.deepEqual([...new Set(remote.presented)], [`x-access-token:${fresh}`], "git presented only the socket's credential, read when git called the helper");
  assert.deepEqual(socket.mints, ["craigoley/remudero-ops"], "the socket minted once, scoped to the fetched repository");

  // A daemon restart closes the socket: git falls back to the env helper, the path the child used before.
  await socket.close();
  remote.presented.length = 0;
  const duringRestart = await fetchAsChild(dir, launch.env);
  assert.notEqual(duringRestart.code, 0, "with no socket and an expired env token the fetch still fails");
  assert.deepEqual(remote.presented, [`x-access-token:${stale}`], "with the socket gone git asked the env helper next");
});

test("W1-T14537 criterion 1: with no daemon socket the child's env is unchanged, and the wiring appends to inherited git config", (t) => {
  assert.equal(typeof cadence.measurementCadenceChildGitCredentialEnv, "function", "the spawn builds the child's git credential wiring");
  const root = ownedFixtureDir(t, "t14537-bare-root").dir;
  const env = { HOME: "/home/node", GH_TOKEN: "ambient" };
  const launch = launchChild(t, { root, env });
  assert.deepEqual(Object.keys(launch.env).filter((key) => key.startsWith("GIT_CONFIG")), [], "no socket bound: no git config is added");
  assert.equal(launch.env.GH_TOKEN, "ambient", "the inherited environment is preserved");

  const wired = cadence.measurementCadenceChildGitCredentialEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" }, "/run/gc/helper.sock");
  assert.equal(wired.GIT_CONFIG_COUNT, "5", "the inherited entry is kept and four are appended");
  assert.equal(wired.GIT_CONFIG_KEY_0, undefined, "the inherited entry itself is left as the base env holds it");
  assert.deepEqual([wired.GIT_CONFIG_KEY_1, wired.GIT_CONFIG_VALUE_1], ["credential.helper", ""], "the helper list is reset first");
  assert.deepEqual([wired.GIT_CONFIG_KEY_2, wired.GIT_CONFIG_VALUE_2], ["credential.useHttpPath", "true"], "the request names its repository");
  assert.match(wired.GIT_CONFIG_VALUE_3 ?? "", /git-credential-socket-helper\.mjs" "\/run\/gc\/helper\.sock"$/, "the socket helper comes next");
  assert.deepEqual([wired.GIT_CONFIG_KEY_4, wired.GIT_CONFIG_VALUE_4], ["credential.helper", ENTRYPOINT_HELPER], "the env helper is the fallback");
  assert.equal(cadence.measurementCadenceChildGitCredentialEnv({ GIT_CONFIG_COUNT: "x" }, "/s").GIT_CONFIG_COUNT, "4", "an unreadable inherited count starts at zero");
  assert.deepEqual(cadence.measurementCadenceChildGitCredentialEnv({}, undefined), {}, "no socket: nothing");
  // The fallback is the container's own helper, verbatim: it cannot drift from what deploy/entrypoint.sh installs.
  assert.equal(cadence.ENV_TOKEN_CREDENTIAL_HELPER, ENTRYPOINT_HELPER);
  assert.ok(readFileSync(join(REPO_ROOT, "deploy", "entrypoint.sh"), "utf8").includes(`'${ENTRYPOINT_HELPER}'`), "deploy/entrypoint.sh installs that helper");
});

/** Fake timers and a movable clock around the real refresh loop. */
function refreshHarness(refresh: (o: RefreshOptions) => Promise<RefreshResult>) {
  let now = T0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const env: NodeJS.ProcessEnv = { GH_APP_ID: "11", GH_APP_INSTALLATION_ID: "22", GH_APP_PRIVATE_KEY_PATH: "/fixture/app-key.pem" };
  let throwOn: string | undefined;
  const handle = startInstallationTokenRefresh({
    env, refresh, now: () => now,
    log: (step, extra) => {
      if (step === throwOn) throw new Error("ENOSPC: ledger write failed");
      rows.push({ step, extra: extra ?? {} });
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
  });
  return {
    env, rows, timers, handle,
    at: (ms: number) => (now = ms),
    throwOn: (step: string) => (throwOn = step),
    fireLast: () => timers.at(-1)!.fn(),
  };
}

/** A refresh that writes a fresh token into env and expires an hour after the clock's now. */
function mintingRefresh(clock: () => number, outcomes: boolean[], minted: string[]) {
  return async (o: RefreshOptions): Promise<RefreshResult> => {
    const ok = outcomes.shift() ?? true;
    if (!ok) return { ok: false, reason: "exchange returned 500" };
    const token = secret("refreshed-token");
    minted.push(token);
    (o.env as NodeJS.ProcessEnv).GH_TOKEN = token;
    return { ok: true, expiresAtMs: clock() + HOUR_MS };
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("W1-T14537 criterion 2: a scheduled refresh that runs after its token expired writes token_refresh_late with how late it ran", async () => {
  let clock = T0;
  const minted: string[] = [];
  const h = refreshHarness(mintingRefresh(() => clock, [true, true, false, false], minted));
  const at = (ms: number) => {
    clock = ms;
    h.at(ms);
  };
  await h.handle.ready;
  assert.equal(h.timers.length, 1, "the first mint armed a refresh");
  const firstDue = T0 + h.timers[0]!.ms;

  // On time: no row.
  at(firstDue);
  h.fireLast();
  await settle();
  assert.deepEqual(h.rows.filter((r) => r.step === LATE_STEP), [], "a refresh inside its token's life writes no late row");

  // The loop is blocked past this token's expiry; the timer fires seven minutes after it, as at 18:05:01Z.
  const secondExpiry = firstDue + HOUR_MS;
  const secondDue = firstDue + h.timers.at(-1)!.ms;
  at(secondExpiry + 7 * MINUTE_MS);
  h.fireLast();
  await settle();
  const late = h.rows.filter((r) => r.step === LATE_STEP);
  assert.equal(late.length, 1, "one late row");
  assert.deepEqual(late[0]!.extra, {
    expires_at: new Date(secondExpiry).toISOString(), late_ms: 7 * MINUTE_MS, timer_lag_ms: secondExpiry + 7 * MINUTE_MS - secondDue,
  }, "the row names the replaced token's expiry, how long after it the refresh ran, and the timer's own lag");

  // That refresh failed; its retry, still past the same expiry, does not repeat the row.
  at(secondExpiry + 10 * MINUTE_MS);
  h.fireLast();
  await settle();
  assert.equal(h.rows.filter((r) => r.step === LATE_STEP).length, 1, "once per replaced token");
});

test("W1-T14537 criterion 2: a late row that cannot be written neither throws out of the timer nor stops the refresh", async (t) => {
  let clock = T0;
  const minted: string[] = [];
  const h = refreshHarness(mintingRefresh(() => clock, [], minted));
  await h.handle.ready;
  const stderr = t.mock.method(process.stderr, "write", () => true);
  h.throwOn(LATE_STEP);
  clock = T0 + HOUR_MS + MINUTE_MS;
  h.at(clock);
  assert.doesNotThrow(() => h.fireLast(), "the timer callback survives a failed write");
  await settle();
  assert.equal(minted.length, 2, "the refresh still ran");
  assert.equal(h.timers.length, 2, "and re-armed");
  assert.ok(stderr.mock.calls.some((call) => String(call.arguments[0]).includes(`${LATE_STEP} row not written`)), "the failed write is reported on stderr");
});

test("W1-T14537 criterion 3: no token, key or helper secret reaches a ledger row, a log line or the child's argv", async (t) => {
  const stale = secret("expired-env-token");
  const fresh = secret("socket-minted-token");
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const root = ownedFixtureDir(t, "t14537-secret-root").dir;
  const remote = await privateRemote(t, fresh);
  const dir = opsTree(remote.url);
  const socket = await daemonSocket(t, root, fresh);
  const launch = launchChild(t, { root, env: containerEnv(t, stale) });
  assert.equal((await fetchAsChild(dir, launch.env)).code, 0, "the wired fetch ran");

  // The real exchange (fetch, key read and clock injected), late, so both refresh rows and the late row are written.
  let clock = T0;
  const issued: string[] = [];
  const h = refreshHarness((o) => refreshInstallationToken({
    ...o, now: () => clock, readKey: () => pem,
    fetchImpl: (async () => {
      const token = secret("installation-token");
      issued.push(token);
      return new Response(JSON.stringify({ token, expires_at: new Date(clock + HOUR_MS).toISOString() }), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  }));
  await h.handle.ready;
  clock = T0 + HOUR_MS + 7 * MINUTE_MS;
  h.at(clock);
  h.fireLast();
  await settle();
  await settle();

  const gitConfig = Object.entries(launch.env).filter(([key]) => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key));
  const lateRows = h.rows.filter((r) => r.step === LATE_STEP);
  const boundaryRows = socket.rows.filter((r) => r.step === "boundary.request");
  // Non-vacuous: every surface checked below exists.
  assert.ok(gitConfig.length >= 7, "the child carries its git credential wiring");
  assert.equal(lateRows.length, 1, "the late row was written");
  assert.ok(boundaryRows.length >= 1, "the socket wrote its mint row");
  assert.equal(issued.length, 2, "two installation tokens were issued");

  const secrets = [stale, fresh, ...issued, pem.split("\n")[1]!, "PRIVATE KEY"];
  const surfaces: Record<string, string> = {
    argv: JSON.stringify([launch.file, ...launch.argv]),
    gitConfig: JSON.stringify(gitConfig),
    refreshRows: JSON.stringify(h.rows),
    socketRows: JSON.stringify(socket.rows),
  };
  for (const [name, text] of Object.entries(surfaces)) {
    for (const value of secrets) assert.ok(!text.includes(value), `${name} carries no secret (${value.slice(0, 14)}...)`);
  }
  for (const [, raw] of gitConfig) {
    const value = raw ?? "";
    assert.ok(value === "" || value === "true" || /^\d+$/.test(value) || /^credential\./.test(value) || value === ENTRYPOINT_HELPER ||
      value.includes(socket.socketPath), `a git config value is a key, a flag, a socket path or a helper command: ${value}`);
  }
});
