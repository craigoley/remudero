/**
 * `rmd serve` STRANDS A PROCESS PER SUITE INVOCATION unless teardown kills the process GROUP.
 *
 * THE MECHANISM, established empirically rather than assumed. `bin/rmd` `exec`s
 * `node_modules/.bin/tsx`, so the spawned pid is tsx's — but the tsx CLI then SPAWNS A CHILD
 * `node` which is the process actually running `src/run-task.ts serve`. Killing the spawned pid
 * therefore kills the wrapper and leaves the grandchild alive, re-parented to PID 1 and still
 * holding its port. MEASURED before the fix: every invocation of test/serve-service-boot.test.ts
 * left one `node ... src/run-task.ts serve --port <n>` behind, on the PASSING path.
 *
 * AND NOTHING REAPS IT. The daemon's `sweepOrphanWorkers` reads `REMUDERO_RUN_ID` and
 * `REMUDERO_TASK_ID` off a candidate's environment (`defaultReadMarkers`) and leaves anything
 * without both alone as `unattributable` — correct for that sweep, and it means a test-spawned
 * server is never collected. In a container the orphans die when the container exits; on a
 * long-lived host they accumulate for as long as the suite keeps being run.
 *
 * BOTH DIRECTIONS OF THE MECHANISM ARE LOCKED HERE, because a test asserting only that the fixed
 * shape reaps would pass just as happily if tsx stopped interposing a child and the whole problem
 * evaporated — at which point the `detached` flag would look like cargo. The NEGATIVE CONTROL
 * spawns the same command WITHOUT `detached`, kills the pid the way the old teardown did, and
 * asserts the grandchild SURVIVES. If that control ever stops failing to reap, the fix is no
 * longer load-bearing and this file should be revisited rather than trusted.
 *
 * Every process this file starts is reaped in its own `after`, including the control's leak.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { killProcessGroup } from "../src/lib/worker-containment.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Every live pid running the REAL serve process for `port` — the tsx-spawned grandchild, never the
 * wrapper.
 *
 * THE WRAPPER MUST BE EXCLUDED OR THIS WHOLE FILE IS VACUOUS. Both processes carry
 * `run-task.ts serve --port <n>` on their command line: the wrapper as
 * `node .../node_modules/.bin/tsx .../run-task.ts serve --port <n>`, and the real server as
 * `node --require .../tsx/dist/preflight.cjs --import .../tsx/dist/loader.mjs .../run-task.ts serve
 * --port <n>`. A matcher that accepted both let `waitForServer` return the instant the WRAPPER
 * appeared — before tsx had spawned anything — so the control killed the wrapper first and observed
 * no survivor, reporting "no leak" for a run in which the server had never started. MEASURED while
 * writing this file. `tsx/dist/loader.mjs` is the discriminator: only the grandchild carries it.
 */
function serversOn(port: number): number[] {
  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter(
      (l) => l.includes("run-task.ts serve") && l.includes(`--port ${port}`) && l.includes("tsx/dist/loader.mjs"),
    )
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isFinite(n));
}

async function waitForServer(port: number, timeoutMs = 45_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = serversOn(port);
    if (pids.length) return pids;
    if (Date.now() > deadline) return [];
    await new Promise((r) => setTimeout(r, 100));
  }
}

function startServe(port: number, detached: boolean) {
  const home = mkdtempSync(join(tmpdir(), "serve-orphan-home-"));
  const out = openSync(join(home, "serve.out.log"), "a", 0o600);
  return spawn(join(repoRoot, "bin", "rmd"), ["serve", "--port", String(port), "--host", "127.0.0.1"], {
    stdio: ["ignore", out, out],
    env: { ...process.env, HOME: home },
    detached,
  });
}

test("killing the process GROUP reaps the serve process the tsx wrapper spawned", async (t) => {
  const port = await freePort();
  const child = startServe(port, true);
  // Belt and braces: whatever this test asserts, nothing survives it.
  t.after(() => killProcessGroup(child.pid!));

  // REACHING THE SPAWN IS ASSERTED FIRST — a teardown test that never started a process proves
  // nothing at all, which is the trap this whole file exists around.
  const running = await waitForServer(port);
  assert.ok(running.length > 0, "the serve process must actually be running before teardown is judged");

  killProcessGroup(child.pid!);
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(serversOn(port), [], "no serve process may survive a group kill");
});

test("the suite that spawns a real serve uses the detached-group shape, not a bare pid kill", () => {
  // THE BEHAVIOURAL TESTS ABOVE DRIVE THEIR OWN SPAWNS, so neither would notice
  // serve-service-boot.test.ts quietly reverting to `child.kill()`. This reads that file directly —
  // the same source-level discipline arm-at-open.test.ts uses for its own wiring claim — so a
  // revert fails here rather than silently resuming the leak.
  const src = readFileSync(fileURLToPath(new URL("./serve-service-boot.test.ts", import.meta.url)), "utf8");
  // COMMENT LINES ARE STRIPPED FIRST. That file's own comment explains the old `child.kill()` shape
  // in prose, so a naive scan of the raw text fails on the explanation rather than on the code —
  // measured while writing this. Same hazard as a proof that greps a comment and passes on unbuilt
  // wiring, just pointing the other way.
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  assert.match(code, /detached:\s*true/, "the serve spawn must create its own process group");
  assert.match(code, /killProcessGroup\(/, "teardown must kill the GROUP, not the spawned pid");
  assert.doesNotMatch(
    code,
    /child\.kill\(/,
    "a bare child.kill() reaches only the tsx wrapper and leaves the server orphaned",
  );
});

test("killing only the spawned pid leaves the grandchild alive — the defect, still reproducible", async (t) => {
  const port = await freePort();
  // NOT detached: the old shape. The pid we hold is tsx's, not the server's.
  const child = startServe(port, false);
  const leaked: number[] = [];
  t.after(() => {
    for (const pid of [...leaked, ...serversOn(port)]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  const running = await waitForServer(port);
  assert.ok(running.length > 0, "the serve process must actually be running before teardown is judged");

  child.kill("SIGKILL"); // exactly what the old teardown did
  await new Promise((r) => setTimeout(r, 1500));
  const survivors = serversOn(port);
  leaked.push(...survivors);
  assert.ok(
    survivors.length > 0,
    "the old teardown must still be shown to leak — if this ever passes cleanly, tsx has stopped " +
      "interposing a child process and the detached-group fix is no longer load-bearing",
  );
});
