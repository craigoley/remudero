/**
 * W1-T13170 — A HOST GIT CALL THAT OVERFLOWS ITS OUTPUT REPORTS THE OVERFLOW, NOT EPIPE.
 *
 * hostWorktreeGitAsync feeds `input` to git's stdin while it waits on the child. When stdout goes past maxBuffer,
 * node kills the child and rejects only on close, while the unfinished stdin write fails with EPIPE at once; a git
 * that exits nonzero before it reads its stdin does the same. Promise.all took the first rejection, so the caller saw
 * "write EPIPE" and not the real cause. INVARIANT the-child-outcome-wins: the child's own failure is the error.
 *
 * FIXTURES ONLY: a gitRepo() temp repository and real git.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childOutcomeWins, hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const SAVED = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "SSH_ASKPASS"] as const;
const saved = new Map(SAVED.map((k) => [k, process.env[k]] as const));
/** Larger than any pipe buffer (64 KiB on Linux, at most 1 MiB with F_SETPIPE_SZ), so the write cannot finish early. */
const LARGE_INPUT_BYTES = 4 * 1024 * 1024;
const BLOB_BYTES = 256 * 1024;

let root: string;
let repo: GitRepo;
let bigBlob: string;
let smallBlob: string;

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code, errno: -1, syscall: "write" });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}overflow-not-epipe-`));
  const globalEmpty = join(root, "global-empty");
  writeFileSync(globalEmpty, "");
  for (const k of ["GIT_ASKPASS", "SSH_ASKPASS"] as const) delete process.env[k];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalEmpty, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  repo = gitRepo({ kind: "overflow-not-epipe" });
  writeFileSync(join(repo.dir, "big.bin"), "x".repeat(BLOB_BYTES));
  writeFileSync(join(repo.dir, "small.txt"), "small blob\n");
  bigBlob = repo.git("hash-object", "-w", "big.bin");
  smallBlob = repo.git("hash-object", "-w", "small.txt");
});

after(() => {
  for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

/** `line` repeated until the input is past {@link LARGE_INPUT_BYTES}. */
function largeInput(line: string): string {
  return line.repeat(Math.ceil(LARGE_INPUT_BYTES / line.length));
}

async function rejection(call: Promise<unknown>): Promise<NodeJS.ErrnoException & { stderr?: string }> {
  try {
    await call;
  } catch (error) {
    return error as NodeJS.ErrnoException & { stderr?: string };
  }
  assert.fail("the call resolved; it must reject");
}

describe("a host git call that overflows its output reports the overflow, not EPIPE", () => {
  it("W1-T13170 criterion 1: cat-file --batch past maxBuffer, fed more than a pipe buffer, rejects with the maxBuffer error", async () => {
    const input = largeInput(`${bigBlob}\n`);
    assert.ok(input.length > LARGE_INPUT_BYTES - 1);
    for (let round = 0; round < 3; round++) {
      const error = await rejection(hostWorktreeGitAsync(repo.dir, ["cat-file", "--batch"], { input, maxBuffer: 4096 }));
      assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", `round ${round}: ${error.message}`);
      assert.notEqual(error.code, "EPIPE");
    }
  });

  it("W1-T13170 criterion 2: a git that exits nonzero before it reads large stdin rejects with its exit code and stderr", async () => {
    const input = largeInput(`${bigBlob}\n`);
    for (let round = 0; round < 3; round++) {
      const error = await rejection(hostWorktreeGitAsync(repo.dir, ["cat-file", "--batch", "--no-such-option-w1-t13170"], { input }));
      assert.equal(error.code as unknown, 129, `round ${round}: ${error.message}`);
      assert.match(String(error.stderr), /no-such-option-w1-t13170/);
    }
  });

  it("W1-T13170 criterion 3: the child outcome wins over any stdin error; a stdin error counts only when the child exited 0", async () => {
    const childError = Object.assign(new Error("Command failed: git cat-file"), { code: 128, stderr: "fatal: bad" });
    for (const stdinError of [errnoError("EPIPE"), errnoError("ECONNRESET"), errnoError("ENOSPC"), new Error("stdin closed")]) {
      const seen = await rejection(childOutcomeWins(Promise.reject(childError), Promise.resolve(stdinError)));
      assert.equal(seen, childError, `the child's error wins over ${stdinError.message}`);
    }
    // The child exited 0: a non-EPIPE stdin error is the call's error; EPIPE is git choosing not to read it all.
    const write = errnoError("ECONNRESET");
    assert.equal(await rejection(childOutcomeWins(Promise.resolve({ stdout: "out" }), Promise.resolve(write))), write);
    assert.deepEqual(await childOutcomeWins(Promise.resolve({ stdout: "out" }), Promise.resolve(errnoError("EPIPE"))), { stdout: "out" });
    assert.deepEqual(await childOutcomeWins(Promise.resolve({ stdout: "out" }), Promise.resolve(undefined)), { stdout: "out" });
    // Real git exits 0 without reading all of its large input: the EPIPE it caused is not an error.
    const out = await hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { input: largeInput("ignored\n") });
    assert.equal(out.trim(), repo.git("rev-parse", "HEAD"));
  });

  it("W1-T13170 criterion 4: a call whose stdin git reads to the end returns its stdout (credential fill, cat-file --batch under maxBuffer)", async () => {
    const fill = await hostWorktreeGitAsync(repo.dir, ["credential", "fill"], {
      input: "protocol=https\nhost=example.invalid\nusername=fixture-user\npassword=fixture-pass\n\n",
    });
    assert.match(fill, /^username=fixture-user$/m);
    assert.match(fill, /^password=fixture-pass$/m);
    const batch = await hostWorktreeGitAsync(repo.dir, ["cat-file", "--batch"], { input: `${smallBlob}\n${bigBlob}\n`, maxBuffer: 1 << 20 });
    assert.ok(batch.startsWith(`${smallBlob} blob 11\nsmall blob\n\n${bigBlob} blob ${BLOB_BYTES}\n`), batch.slice(0, 200));
    assert.equal(batch.length, `${smallBlob} blob 11\nsmall blob\n\n${bigBlob} blob ${BLOB_BYTES}\n`.length + BLOB_BYTES + 1);
  });
});
