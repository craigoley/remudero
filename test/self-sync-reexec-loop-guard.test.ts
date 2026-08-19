import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SELF_SYNC_GUARD_ENV, checkCliFreshness } from "../src/lib/self-sync.js";

// THE RECURSIVE RE-EXEC (#2237). `defaultReexec` spawns the child with SELF_SYNC_GUARD_ENV in the
// CHILD PROCESS'S ENVIRONMENT — it cannot reach into whatever object that child's caller will
// later hand to `checkCliFreshness`. While the guard was read ONLY from that injected argument, a
// caller passing a literal `{}` never saw it: the child re-ran the same path, called `reexec()`
// again, and blocked in `spawnSync` forever. Because the re-exec replays `process.argv.slice(1)`,
// inside `node --test` that argv IS THE TEST RUNNER, so each level spawned a full suite.
// MEASURED: six runners killed across four attempts of BOTH `ci` and `coverage-ratchet`, each
// emitting 507 `### rmd self-sync:` lines with ZERO tests completing, against a green-run control
// of 0. `isCiEnv({})` is false for the same reason, so CI's own short-circuit missed it too.

function gitFixture(): { originDir: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-reexec-guard-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(originDir, { recursive: true });
  const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "--quiet", "-b", "main", originDir]);
  git(originDir, ["config", "user.email", "t@t"]);
  git(originDir, ["config", "user.name", "t"]);
  writeFileSync(join(originDir, "seed.txt"), "one\n");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "t@t"]);
  git(localDir, ["config", "user.name", "t"]);
  // Publish a commit so the clone is BEHIND — the only state that can reach the sync+reexec path.
  writeFileSync(join(originDir, "published.txt"), "pub\n");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "published"]);
  return { originDir, localDir };
}

function withProcessEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[key] = previous;
    else delete process.env[key];
  }
}

test("the loop guard is read from process.env, where defaultReexec writes it — not only from the injected env", () => {
  // THE REGRESSION, AT ITS ROOT. The call passes an EMPTY env object, exactly as the call site
  // that triggered the incident does. Before the fix this returned a live decision (and, on a
  // relaxed dirty check, `synced` — which calls reexec()); after it, the process-level guard is
  // honoured and the whole check short-circuits.
  const { localDir } = gitFixture();
  let reexecCalls = 0;
  const result = withProcessEnv(SELF_SYNC_GUARD_ENV, "1", () =>
    checkCliFreshness(localDir, {}, { say: () => {}, warn: () => {}, log: () => {}, reexec: () => { reexecCalls += 1; } }),
  );
  assert.equal(result.status, "guarded", "a re-exec child must be guarded even when its caller passes {}");
  assert.equal(reexecCalls, 0, "a guarded call must never re-exec — this is the recursion stop");
});

test("PRECONDITION: without the guard set, the SAME fixture really does reach a live decision", () => {
  // Without this the test above is vacuous — it would pass on a `checkCliFreshness` that returned
  // "guarded" unconditionally, or on a fixture too broken to get anywhere.
  const { localDir } = gitFixture();
  const result = withProcessEnv(SELF_SYNC_GUARD_ENV, undefined, () =>
    checkCliFreshness(localDir, {}, { say: () => {}, warn: () => {}, log: () => {}, reexec: () => {} }),
  );
  assert.notEqual(result.status, "guarded", "the fixture must be able to reach a real decision");
});

test("the injected env still wins on its own — a plain object carrying the guard is honoured with no process.env involved", () => {
  // The added channel must not REPLACE the injected one; tests that force the guarded branch with
  // a plain object keep working.
  const { localDir } = gitFixture();
  let reexecCalls = 0;
  const result = withProcessEnv(SELF_SYNC_GUARD_ENV, undefined, () =>
    checkCliFreshness(localDir, { [SELF_SYNC_GUARD_ENV]: "1" }, { reexec: () => { reexecCalls += 1; } }),
  );
  assert.equal(result.status, "guarded");
  assert.equal(reexecCalls, 0);
});

test("a value other than the literal \"1\" does NOT guard — the check stays exact in both channels", () => {
  // Fail-open on a junk value is the pre-existing contract (`=== \"1\"`), and widening it to
  // truthiness here would silently disable auto-sync for anyone with the variable set to \"0\".
  const { localDir } = gitFixture();
  const result = withProcessEnv(SELF_SYNC_GUARD_ENV, "0", () =>
    checkCliFreshness(localDir, {}, { say: () => {}, warn: () => {}, log: () => {}, reexec: () => {} }),
  );
  assert.notEqual(result.status, "guarded", "\"0\" must not guard — only the literal \"1\" does");
});

test("defaultReexec itself refuses to spawn inside a re-exec child — the second, independent stop", () => {
  // The decision guard above can be bypassed by any caller that computes its own status; nothing
  // can recurse without passing through the real reexec. This asserts the source-level stop is
  // present and reads process.env, because a test cannot safely EXERCISE a real re-exec: it
  // replays process.argv, which under `node --test` is the runner itself.
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "self-sync.ts"), "utf8");
  const body = src.slice(src.indexOf("function defaultReexec("));
  const spawnAt = body.indexOf("spawnSync(");
  assert.ok(spawnAt > 0, "sanity: defaultReexec must still spawn");
  assert.ok(
    body.slice(0, spawnAt).includes("process.env[SELF_SYNC_GUARD_ENV]"),
    "defaultReexec must check the process-level guard BEFORE it spawns",
  );
});
