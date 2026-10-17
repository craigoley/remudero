import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChildMain } from "../src/run-child-main.js";
import { startInstallationTokenRefresh } from "../src/lib/github-app.js";
import { RUN_CHILD_SCHEMA, readStatus, writeSpec } from "../src/lib/run-child-contract.js";
import {
  runChildCredentialSocket, startRunChildGitCredentialSocket, startDaemonGitCredentialSocket,
} from "../src/lib/secret-boundary.js";
import { repoRoot as findRepoRoot } from "./helpers/repo-root.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-child-creds-"));
  const plan = join(dir, "plan.json");
  writeFileSync(plan, JSON.stringify({ tasks: [] }));
  writeSpec(dir, {
    schema: RUN_CHILD_SCHEMA, taskId: "W1-T9083", runId: dir.split("/").at(-1)!, instance: "test",
    engine: { sourceHash: "a".repeat(64), sha: "b".repeat(40) }, planSnapshotPath: plan,
    reservationId: "test", options: {},
  });
  const env = { GH_APP_ID: "1", GH_APP_INSTALLATION_ID: "2", GH_APP_PRIVATE_KEY_PATH: "/unused", GH_TOKEN: "daemon-token" };
  return { dir, env };
}

function request(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let reply = "";
    socket.on("error", reject);
    socket.on("data", (data) => { reply += data; });
    socket.on("end", () => resolve(reply));
    socket.on("connect", () => socket.end("protocol=https\nhost=github.com\npath=owner/repo.git\n\n"));
  });
}

const minted = async () => ({ ok: true, expiresAtMs: Date.now() + 3_600_000 });
const socketStarter: typeof startRunChildGitCredentialSocket = (opts) =>
  startRunChildGitCredentialSocket({ ...opts, mint: async () => ({ ok: true, token: "child-scoped-token" }) });

test("W1-T9083: a run child refreshes its own installation token", async () => {
  const { dir, env } = fixture();
  let calls = 0;
  let tick: (() => void) | undefined;
  const cleared: unknown[] = [];
  const timer = {};
  const code = await runChildMain(["--run-dir", dir, "--probe"], {
    env, startCredentialSocket: socketStarter,
    tokenRefresh: {
      refresh: async (opts) => {
        assert.equal(opts.env, env);
        env.GH_TOKEN = `child-token-${++calls}`;
        return minted();
      },
      setTimer: (fn) => { tick = fn; return timer; },
      clearTimer: (handle) => { cleared.push(handle); },
    },
    loadRunPath: async () => {
      assert.equal(env.GH_TOKEN, "child-token-1");
      tick!();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(env.GH_TOKEN, "child-token-2");
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(cleared, [timer]);
  tick!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "a stopped child must mint no further tokens");
  assert.doesNotMatch(readFileSync(join(dir, "spec.json"), "utf8"), /daemon-token|child-token/);
  assert.doesNotMatch(readFileSync(join(dir, "status.json"), "utf8"), /daemon-token|child-token/);
});

test("W1-T9083: the credential socket lives under the run directory and is removed at exit", async () => {
  const { dir, env } = fixture();
  const socketPath = join(dir, "git.sock");
  assert.equal(await runChildMain(["--run-dir", dir, "--probe"], {
    env, tokenRefresh: { refresh: minted },
    startCredentialSocket: async (opts) => {
      const handle = await socketStarter(opts);
      return { ...handle, close: async () => {
        const status = readStatus(dir);
        assert.ok(status.ok);
        assert.equal(status.value.state, "starting", "close precedes terminal status");
        await handle.close();
      } };
    },
    loadRunPath: async () => {
      assert.equal(runChildCredentialSocket("/dead/daemon.sock"), socketPath);
      assert.ok(existsSync(socketPath));
      assert.match(await request(socketPath), /password=child-scoped-token/);
    },
  }), 0);
  assert.equal(existsSync(socketPath), false);
  const status = readStatus(dir);
  assert.ok(status.ok);
  assert.equal(status.value.state, "done");
  assert.equal(runChildCredentialSocket("/daemon.sock"), "/daemon.sock");
});

test("W1-T9083: the child socket answers after the daemon socket closes", async () => {
  const { dir, env } = fixture();
  const daemon = await startDaemonGitCredentialSocket({
    ready: Promise.resolve(), stateDir: join(dir, "daemon"), log: () => {},
    mint: async () => ({ ok: true, token: "daemon-scoped-token" }),
  });
  assert.ok(daemon);
  let reply: string | undefined;
  try {
    assert.equal(await runChildMain(["--run-dir", dir, "--probe"], {
      env, tokenRefresh: { refresh: minted }, startCredentialSocket: socketStarter,
      loadRunPath: async () => {
        assert.match(await request(daemon.socketPath), /daemon-scoped-token/);
        await daemon.close();
        const childPath = runChildCredentialSocket(daemon.socketPath);
        assert.equal(childPath, join(dir, "git.sock"));
        reply = await request(childPath!);
      },
    }), 0);
    assert.equal(reply, "username=x-access-token\npassword=child-scoped-token\n");
  } finally {
    if (existsSync(daemon.socketPath)) await daemon.close();
  }
  assert.equal(existsSync(join(dir, "git.sock")), false);
});

test("W1-T9083: a child without credentials fails as spawn_infra_blocked", async () => {
  for (const failure of ["mint", "mint-throws", "socket", "close"] as const) {
    const { dir, env } = fixture();
    let loaded = false;
    const code = await runChildMain(["--run-dir", dir, "--probe"], {
      env, stderr: () => {},
      tokenRefresh: { refresh: async () => {
        if (failure === "mint-throws") throw new Error("exchange unavailable");
        return failure === "mint" ? { ok: false, reason: "exchange rejected" } : minted();
      } },
      startCredentialSocket: async (opts) => {
        if (failure === "socket") throw new Error("socket unavailable");
        const handle = await socketStarter(opts);
        return { ...handle, close: async () => {
          await handle.close();
          if (failure === "close") throw new Error("socket cleanup failed");
        } };
      },
      loadRunPath: async () => { loaded = true; },
    });
    assert.equal(code, 1);
    assert.equal(loaded, failure === "close");
    const status = readStatus(dir);
    assert.ok(status.ok);
    assert.equal(status.value.state, "failed");
    assert.equal(status.value.failure?.reasonClass, "spawn_infra_blocked");
    assert.equal(existsSync(join(dir, "git.sock")), false);
  }
});

test("unconfigured children retain ambient credentials and start no socket", async () => {
  const { dir } = fixture();
  assert.equal(await runChildMain(["--run-dir", dir, "--probe"], {
    env: {}, loadRunPath: async () => {
      assert.equal(runChildCredentialSocket("/daemon.sock"), undefined);
    },
    startCredentialSocket: async () => { throw new Error("must not start"); },
  }), 0);
});

test("the real bundled child starts its socket thread and cleans up before exiting", { timeout: 120_000 }, async () => {
  const { dir } = fixture();
  const repo = findRepoRoot();
  const engine = join(dir, "engine");
  mkdirSync(engine);
  cpSync(join(repo, "src"), join(engine, "src"), { recursive: true });
  for (const name of readdirSync(repo)) {
    if ([".git", "src", "dist", "state", "test"].includes(name)) continue;
    symlinkSync(join(repo, name), join(engine, name));
  }
  const build = createRequire(import.meta.url)(join(repo, "scripts", "build-child-entries.mjs"));
  await build.buildChildEntries({ root: engine, entries: [{ name: "run-child", source: "src/run-child-main.ts" }], workers: [] });
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const keyPath = join(dir, "fixture-key.pem");
  writeFileSync(keyPath, key);
  const preload = join(dir, "fixture-fetch.mjs");
  writeFileSync(preload, `
    import { writeFileSync } from "node:fs";
    import { workerData } from "node:worker_threads";
    if (workerData?.kind === "rmd-git-credential-socket") {
      writeFileSync(${JSON.stringify(join(dir, "thread-started.json"))}, JSON.stringify(workerData));
    }
    process.env.GH_APP_ID = "1";
    process.env.GH_APP_INSTALLATION_ID = "2";
    process.env.GH_APP_PRIVATE_KEY_PATH = ${JSON.stringify(keyPath)};
    globalThis.fetch = async () => new Response(JSON.stringify({
      token: "fixture-child-token", expires_at: new Date(Date.now() + 3600000).toISOString()
    }), { status: 201 });
  `);
  const child = spawnSync(process.execPath, [
    "--import", preload, join(engine, "dist", "child-entries", "run-child.mjs"), "--run-dir", dir, "--probe",
  ], { encoding: "utf8", timeout: 60_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.error, undefined);
  const status = readStatus(dir);
  assert.ok(status.ok);
  assert.equal(status.value.state, "done");
  assert.equal(status.value.entryKind, "bundle");
  assert.equal(JSON.parse(readFileSync(join(dir, "thread-started.json"), "utf8")).socketPath, join(dir, "git.sock"));
  assert.equal(existsSync(join(dir, "git.sock")), false);
});

test("the real socket thread answers and refuses a run directory that cannot bind", async () => {
  const { dir } = fixture();
  const child = await startRunChildGitCredentialSocket({ runDir: dir, log: () => {} });
  try {
    assert.equal(await request(child.socketPath), "", "a thread without App configuration refuses a mint");
  } finally {
    await child.close();
  }
  await assert.rejects(startRunChildGitCredentialSocket({ runDir: join(dir, "missing"), log: () => {} }), /ENOENT/);
  await assert.rejects(startRunChildGitCredentialSocket({ runDir: join(dir, "x".repeat(110)), log: () => {} }), /unix socket limit/);
});

test("a task load failure still removes the child's socket before writing failed", async () => {
  const { dir, env } = fixture();
  assert.equal(await runChildMain(["--run-dir", dir, "--probe"], {
    env, tokenRefresh: { refresh: minted }, startCredentialSocket: socketStarter, stderr: () => {},
    loadRunPath: async () => { throw new Error("load failed"); },
  }), 1);
  assert.equal(existsSync(join(dir, "git.sock")), false);
  const status = readStatus(dir);
  assert.ok(status.ok);
  assert.equal(status.value.state, "failed");
  assert.match(status.value.failure?.message ?? "", /load failed/);
});

test("stopping a refresh during its first mint prevents a later timer from being armed", async () => {
  const { env } = fixture();
  let finish: (result: { ok: boolean; expiresAtMs: number }) => void = () => {};
  let timers = 0;
  const refresh = startInstallationTokenRefresh({
    env, log: () => {}, refresh: () => new Promise((resolve) => { finish = resolve; }),
    setTimer: () => { timers++; return {}; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  refresh.stop!();
  finish({ ok: true, expiresAtMs: Date.now() + 3_600_000 });
  await refresh.ready;
  assert.equal(timers, 0);
});

test("a timer cleanup error still closes the socket and records an infrastructure failure", async () => {
  const { dir, env } = fixture();
  const errors: string[] = [];
  assert.equal(await runChildMain(["--run-dir", dir, "--probe"], {
    env, startCredentialSocket: socketStarter, loadRunPath: async () => {}, stderr: (text) => errors.push(text),
    tokenRefresh: { refresh: minted, setTimer: () => ({}), clearTimer: () => { throw new Error("timer cleanup failed"); } },
  }), 1);
  assert.equal(existsSync(join(dir, "git.sock")), false);
  const status = readStatus(dir);
  assert.ok(status.ok);
  assert.equal(status.value.failure?.reasonClass, "spawn_infra_blocked");
  assert.match(status.value.failure?.message ?? "", /timer cleanup failed/);
  assert.ok(errors.some((text) => text.includes("credential cleanup failed")));
});
