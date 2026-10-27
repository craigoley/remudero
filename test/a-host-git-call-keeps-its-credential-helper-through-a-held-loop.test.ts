/**
 * A HOST GIT CALL KEEPS ITS CREDENTIAL HELPER THROUGH A HELD LOOP.
 *
 * On 2026-10-15 three daemon pushes (W1-T9047's run push at 04:10:39Z; the #11939 and #11918 fix-round pushes at
 * 07:36:46-47Z) died on "could not read Username" while the credential socket minted before and after them and
 * logged no request for them. Each followed a daemon.loop_lag of 69-118 s. The async leaf read the pinned config
 * with execFile's own 30 s `timeout`: when a held loop resumes, Node runs that due timer before the child's exit,
 * the timer destroys the unread stdout, and the read RESOLVES with an empty listing. Vetted as empty, the call
 * carried only the credential reset, so git had no helper at all.
 *
 * FIXTURES ONLY: a gitRepo() wired to a fixture unix socket, and `git credential fill`.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import * as leaf from "#src/lib/worktree-git.js";
import { wireCredentialHelperSocket } from "#src/lib/worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const SOCKET_PASS = "fixture-socket-pass";
const SAVED = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "SSH_ASKPASS"] as const;
const saved = new Map(SAVED.map((k) => [k, process.env[k]] as const));
const CONFIG_LIST = ["config", "--list", "--show-scope", "--null", "--no-includes"];
const execFilePromise = promisify(execFile);

let root: string;
let socketPath: string;
let sockets: Server;
let requests = 0;

/** Holds the event loop the way the daemon's synchronous spawns did. */
function holdLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* held */ }
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}held-loop-cred-`));
  socketPath = join(root, "s.sock");
  sockets = createServer((c) => c.once("data", () => {
    requests++;
    c.end(`username=x-access-token\npassword=${SOCKET_PASS}\n`);
  }));
  await new Promise<void>((resolve) => sockets.listen(socketPath, resolve));
  const globalEmpty = join(root, "global-empty");
  writeFileSync(globalEmpty, "");
  for (const k of ["GIT_ASKPASS", "SSH_ASKPASS"] as const) delete process.env[k];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalEmpty, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
});

after(() => {
  sockets?.close();
  leaf.setHarnessCredentialSocket(undefined);
  for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

describe("a host git call keeps its credential helper through a held loop", () => {
  it("a host git call whose config read outlives its deadline in a held loop keeps the wired socket credential", async () => {
    const repo = gitRepo({ kind: "held-loop-cred" });
    repo.git("config", "extensions.worktreeConfig", "true");
    wireCredentialHelperSocket(repo.dir, socketPath);
    leaf.setHarnessCredentialSocket(socketPath);
    const before = requests;
    // The pinned config read is spawned before the call returns; the loop is then held past its budget, as the
    // daemon's synchronous spawns held it for 69-118 s on 2026-10-15.
    const fill = leaf.hostWorktreeGitAsync(repo.dir, ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\npath=fixture/repo.git\n\n", configReadTimeoutMs: 200,
    });
    holdLoop(2000);
    const out = await fill;
    assert.match(out, new RegExp(`password=${SOCKET_PASS}`), "git got its credential from the wired socket");
    assert.equal(requests, before + 1, "the socket served the request");
  });

  it("a host git child that exits while the loop is held past its deadline keeps its whole output", async () => {
    const repo = gitRepo({ kind: "held-loop-read" });
    // Control: execFile's own timeout, held past it, resolves with the output cut away.
    const plain = execFilePromise("git", CONFIG_LIST, { cwd: repo.dir, encoding: "utf8", timeout: 200 });
    holdLoop(2000);
    const cut = await plain.then((r) => r.stdout, () => "rejected");
    assert.equal(cut, "", "control: a plain timeout hands back an empty listing after a held loop");

    const bounded = leaf.execFileLoopBounded("git", CONFIG_LIST, { cwd: repo.dir, encoding: "utf8", timeout: 200 });
    holdLoop(2000);
    const { stdout } = await bounded;
    assert.match(stdout, /^local\0core\./m, "the loop-bounded read keeps the repository's own config");
  });

  it("a host git child still running when its loop-available budget is spent is killed", async () => {
    // The child would run for a minute; the budget kills it on a free loop.
    await assert.rejects(
      leaf.execFileLoopBounded(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { encoding: "utf8", timeout: 300 }),
      (e: unknown) => (e as { killed?: boolean }).killed === true,
    );
  });
});
