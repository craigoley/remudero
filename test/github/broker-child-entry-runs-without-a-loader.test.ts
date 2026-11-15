import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghBrokerClientSpawn, ghBrokerDir, NO_LOADER_PRELOAD } from "#src/lib/gh-read-broker-client.js";
import { GhReadBroker, serveGhReadBroker, type GhUpstreamExec } from "#src/lib/gh-read-broker.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { MAX_UNIX_SOCKET_PATH_BYTES, shortPathWhenTooLong } from "#src/lib/short-path-root.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T11741 — the broker's synchronous client child, started the way the BUNDLED daemon starts it: a parent
// whose execArgv is empty, so there is no tsx to forward. The child is the REAL entry under the REAL node.

function tmp(t: TestContext): string {
  const path = shortPathWhenTooLong(join(tmpdir(), "rmd-nl-"), (root) => join(root, "rmd-nl-"),
    (candidate) => Buffer.byteLength(join(`${candidate}XXXXXX`, "cache", "remudero", "gh-broker", "broker.sock")) <= MAX_UNIX_SOCKET_PATH_BYTES,
    existsSync);
  const dir = mkdtempSync(path);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A child's environment with nothing that could load a TypeScript loader or a coverage session into it. */
function plainEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.NODE_OPTIONS = "";
  env.NODE_V8_COVERAGE = "";
  env.NODE_TEST_CONTEXT = "";
  return env;
}

function run(file: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: plainEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
    child.stderr.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("broker child starts and serves a read under plain Node with an empty execArgv", { timeout: 60_000 }, async (t) => {
  const cache = tmp(t);
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  const upstream: string[][] = [];
  const exec: GhUpstreamExec = async (args) => {
    upstream.push(args);
    return args[1] === "user"
      ? { stdout: "octo\n", stderr: "", exitCode: 0 }
      : { stdout: "HTTP/2.0 200 OK\r\nCache-Control: private, max-age=60\r\n\r\n{\"n\":11741}", stderr: "", exitCode: 0 };
  };
  const broker = new GhReadBroker(dir, exec, clockFromMillisFn(() => Date.now()), async () => {}, () => 1e12);
  const server = await serveGhReadBroker({ dir, broker });
  t.after(() => server.close());

  const spawned = ghBrokerClientSpawn(server.socketPath, ["api", "repos/o/r/pulls/7"], "agent", []);
  assert.ok(spawned.args.includes(NO_LOADER_PRELOAD), "an empty execArgv gets the no-loader preload, not a tsx flag");
  assert.ok(!spawned.args.some((a) => /tsx/.test(a)), "no tsx anywhere in the child's argv");
  const out = await run(spawned.file, spawned.args);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, "{\"n\":11741}", "the read round-trips through the broker as gh would have answered it");
  assert.equal(out.stderr, "");
  assert.equal(upstream.filter((a) => a[1] !== "user").length, 1, "the read reached the broker's upstream exactly once");
});

test("broker child startup failure is reported instead of swallowed", { timeout: 60_000 }, async (t) => {
  // The entry alone in a tree with no src/lib: the client import cannot load, which is a child that cannot start.
  const root = tmp(t);
  mkdirSync(join(root, "src"));
  const entry = join(root, "src", "gh-read-broker-client-main.ts");
  copyFileSync(join(REPO_ROOT, "src", "gh-read-broker-client-main.ts"), entry);
  const out = await run(process.execPath, ["--import", NO_LOADER_PRELOAD, entry, join(root, "nowhere.sock"), "agent", "api", "x"]);
  assert.equal(out.code, 1, "a child that cannot start exits non-zero");
  assert.match(out.stderr, /gh-broker: client failed to start \(/, "and says so under its own prefix");
  assert.equal(out.stdout, "", "it answers no read");
});
