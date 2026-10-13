import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// #7588: test/mint-open-pr-surface-is-rest.test.ts gives a fixture a synthetic https://github.com/o/r.git origin,
// and scripts/task-id-existence-check.mjs runs `git ls-remote` against it. Under a PTY with normal prompting, a
// local preflight shard sat at "Username for https://github.com" until it was stopped with no verdict. The test
// setup (test/setup/no-live-remote.ts) now sets GIT_TERMINAL_PROMPT=0 for the whole process and its children, so
// git refuses to prompt instead of opening the terminal. This reads that through a REAL git against a local
// server that demands credentials: no network, and the answer comes back in seconds rather than never.

test("a git read from a test process that is asked for credentials fails at once instead of prompting", { timeout: 30_000 }, async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}git-prompt-`));
  t.after(() => {
    server.close();
    rmSync(home, { recursive: true, force: true });
  });
  const { port } = server.address() as AddressInfo;
  assert.equal(process.env.GIT_TERMINAL_PROMPT, "0", "the test setup turns git's terminal prompt off for the whole process");

  // No credential helper, askpass program or proxy may answer in the prompt's place: only the prompt is left.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  const started = Date.now();
  const stderr = await new Promise<string>((resolve) => {
    execFile(
      "git",
      ["-c", "credential.helper=", "-c", "core.askPass=", "-c", "http.proxy=", "ls-remote", `http://127.0.0.1:${port}/o/r.git`],
      { env, timeout: 20_000 },
      (error, _stdout, err) => {
        assert.ok(error, "an unauthorised read must fail, never succeed");
        resolve(String(err));
      },
    );
  });
  assert.match(stderr, /terminal prompts disabled/, "git refused to prompt rather than failing for some other reason");
  assert.ok(Date.now() - started < 20_000, "and it answered before the bound, so nothing waited on a terminal");
});
