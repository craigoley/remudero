import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { runChildMain } from "#src/run-child-main.js";
import { RUN_CHILD_SCHEMA, readStatus, writeSpec } from "#src/lib/run-child-contract.js";
import { runChildCredentialSocket, startRunChildGitCredentialSocket } from "#src/lib/secret-boundary.js";
import { MAX_UNIX_SOCKET_PATH_BYTES } from "#src/lib/short-path-root.js";

function fixture(t: TestContext, long = true) {
  const root = mkdtempSync(join(tmpdir(), "rmd-long-child-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runDir = long ? join(root, "x".repeat(MAX_UNIX_SOCKET_PATH_BYTES)) : root;
  mkdirSync(runDir, { recursive: true, mode: 0o755 });
  const name = `rmd-rc-${createHash("sha256").update(resolve(runDir)).digest("hex").slice(0, 12)}`;
  const shortDir = join(realpathSync("/tmp"), name);
  assert.equal(existsSync(shortDir), false, "this fixture must not reuse another run's directory");
  t.after(() => rmSync(shortDir, { recursive: true, force: true }));
  return { root, runDir, shortDir };
}

function request(socketPath: string): Promise<string> {
  return new Promise((resolveReply, reject) => {
    const socket = connect(socketPath);
    let reply = "";
    socket.on("error", reject);
    socket.on("data", (data) => { reply += data; });
    socket.on("end", () => resolveReply(reply));
    socket.on("connect", () => socket.end("protocol=https\nhost=github.com\npath=owner/repo.git\n\n"));
  });
}

test("W1-T12138 criterion 1: a long run directory binds, serves and removes a private short socket", async (t) => {
  const { runDir, shortDir } = fixture(t);
  assert.ok(Buffer.byteLength(join(runDir, "git.sock")) > MAX_UNIX_SOCKET_PATH_BYTES);
  const handle = await startRunChildGitCredentialSocket({ runDir, log: () => {}, mint: async (repo) => {
    assert.equal(repo, "owner/repo");
    return { ok: true, token: "long-run-scoped-token" };
  } });
  try {
    assert.equal(handle.socketPath, join(shortDir, "git.sock"));
    assert.ok(Buffer.byteLength(handle.socketPath) <= MAX_UNIX_SOCKET_PATH_BYTES);
    assert.equal(lstatSync(handle.socketPath).isSocket(), true);
    assert.equal(lstatSync(handle.socketPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(shortDir).isDirectory(), true);
    assert.equal(lstatSync(shortDir).uid, process.getuid!());
    assert.equal(lstatSync(shortDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(runDir).mode & 0o777, 0o700);
    assert.equal(await request(handle.socketPath), "username=x-access-token\npassword=long-run-scoped-token\n");
  } finally {
    await handle.close();
  }
  assert.equal(existsSync(handle.socketPath), false);
  assert.equal(existsSync(shortDir), false);
  assert.equal(existsSync(runDir), true);
});

test("W1-T12138 criterion 2: short paths stay local and symlinked fallback directories fail closed", async (t) => {
  await t.test("a short run directory keeps its socket and directory", async (t) => {
    const { runDir } = fixture(t, false);
    assert.ok(Buffer.byteLength(join(runDir, "git.sock")) <= MAX_UNIX_SOCKET_PATH_BYTES);
    const handle = await startRunChildGitCredentialSocket({ runDir, log: () => {}, mint: async () => ({ ok: false, reason: "fixture" }) });
    try {
      assert.equal(handle.socketPath, join(runDir, "git.sock"));
      assert.equal(lstatSync(runDir).mode & 0o777, 0o700);
    } finally {
      await handle.close();
    }
    assert.equal(existsSync(handle.socketPath), false);
    assert.equal(existsSync(runDir), true);
  });
  await t.test("a symlink and its target socket are never removed", async (t) => {
    const { root, runDir, shortDir } = fixture(t);
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o755 });
    writeFileSync(join(target, "git.sock"), "must survive");
    symlinkSync(target, shortDir);
    await assert.rejects(startRunChildGitCredentialSocket({ runDir, log: () => {} }), /not a directory this .* owns/);
    assert.equal(lstatSync(shortDir).isSymbolicLink(), true);
    assert.equal(readFileSync(join(target, "git.sock"), "utf8"), "must survive");
    assert.equal(lstatSync(target).mode & 0o777, 0o755);
  });
});

test("W1-T12138 criterion 3: a long-path child keeps tokens in memory and cleans up before done", async (t) => {
  const { runDir, shortDir } = fixture(t);
  const plan = join(runDir, "plan.json");
  writeFileSync(plan, JSON.stringify({ tasks: [] }));
  writeSpec(runDir, {
    schema: RUN_CHILD_SCHEMA, taskId: "W1-T12138", runId: basename(runDir), instance: "test",
    engine: { sourceHash: "a".repeat(64), sha: "b".repeat(40) }, planSnapshotPath: plan,
    reservationId: "test", options: {},
  });
  const env = { GH_APP_ID: "1", GH_APP_INSTALLATION_ID: "2", GH_APP_PRIVATE_KEY_PATH: "/unused", GH_TOKEN: "parent-token" };
  const logs: unknown[] = [];
  const timer = {};
  let stopped = false;
  let closed = false;
  let loaded = false;
  const code = await runChildMain(["--run-dir", runDir, "--probe"], {
    env, stderr: () => {},
    tokenRefresh: {
      refresh: async () => { env.GH_TOKEN = "child-installation-token"; return { ok: true, expiresAtMs: Date.now() + 3_600_000 }; },
      setTimer: () => timer,
      clearTimer: (handle) => { assert.equal(handle, timer); stopped = true; },
    },
    startCredentialSocket: async (opts) => {
      const handle = await startRunChildGitCredentialSocket({ ...opts,
        log: (step, fields) => logs.push({ step, fields }),
        mint: async () => ({ ok: true, token: "child-scoped-token" }),
      });
      assert.equal(handle.socketPath, join(shortDir, "git.sock"));
      return { ...handle, close: async () => {
        const status = readStatus(runDir);
        assert.ok(status.ok);
        assert.equal(status.value.state, "starting");
        await handle.close();
        assert.equal(existsSync(shortDir), false);
        closed = true;
      } };
    },
    loadRunPath: async () => {
      loaded = true;
      assert.equal(env.GH_TOKEN, "child-installation-token");
      const socketPath = runChildCredentialSocket("/dead/daemon.sock");
      assert.equal(socketPath, join(shortDir, "git.sock"));
      assert.equal(await request(socketPath!), "username=x-access-token\npassword=child-scoped-token\n");
      assert.deepEqual(readdirSync(shortDir), ["git.sock"]);
    },
  });
  assert.equal(code, 0);
  assert.equal(loaded, true);
  assert.equal(stopped, true);
  assert.equal(closed, true);
  assert.equal(existsSync(shortDir), false);
  const status = readStatus(runDir);
  assert.ok(status.ok);
  assert.equal(status.value.state, "done");
  for (const name of readdirSync(runDir)) {
    assert.doesNotMatch(readFileSync(join(runDir, name), "utf8"), /parent-token|child-installation-token|child-scoped-token/);
  }
  assert.doesNotMatch(JSON.stringify(logs), /parent-token|child-installation-token|child-scoped-token/);
});

test("a long-path socket startup failure removes its owned fallback directory", async (t) => {
  const { runDir, shortDir } = fixture(t);
  await assert.rejects(startRunChildGitCredentialSocket({
    runDir, log: () => {}, threadUrl: pathToFileURL(join(runDir, "missing-thread.mjs")),
  }), /Cannot find module/);
  assert.equal(existsSync(join(shortDir, "git.sock")), false);
  assert.equal(existsSync(shortDir), false);
});
