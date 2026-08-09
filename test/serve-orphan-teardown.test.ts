/**
 * `rmd serve` STRANDS A PROCESS PER SUITE INVOCATION unless teardown kills the process GROUP.
 *
 * THE MECHANISM, established empirically rather than assumed. `bin/rmd` `exec`s
 * `node_modules/.bin/tsx`, so the spawned pid is tsx's — but the tsx CLI then SPAWNS A CHILD
 * `node` which is the process actually running `src/run-task.ts serve`. Killing the spawned pid
 * therefore kills the wrapper and, on this project's Linux containers, leaves the grandchild alive,
 * re-parented to PID 1 and still holding its port. MEASURED there before the fix: every invocation
 * of test/serve-service-boot.test.ts left one `node ... src/run-task.ts serve --port <n>` behind, on
 * the PASSING path.
 *
 * AND NOTHING REAPS IT. The daemon's `sweepOrphanWorkers` reads `REMUDERO_RUN_ID` and
 * `REMUDERO_TASK_ID` off a candidate's environment (`defaultReadMarkers`) and leaves anything
 * without both alone as `unattributable` — correct for that sweep, and it means a test-spawned
 * server is never collected. In a container the orphans die when the container exits; on a
 * long-lived host they accumulate for as long as the suite keeps being run.
 *
 * WHAT IS LOCKED HERE, AND WHAT DELIBERATELY IS NOT. A test asserting only that the fixed shape
 * reaps would pass just as happily if tsx stopped interposing a child and the whole problem
 * evaporated — at which point `detached` would look like cargo. So the PRECONDITION is asserted
 * instead: the pid `spawn` returns is not the pid serving. That is environment-independent and is
 * exactly what makes a `child.pid`-based teardown aim at the wrong process.
 *
 * The LEAK ITSELF is not asserted. An earlier revision did assert it, and it failed on CI twice
 * (including the flake retry) while passing locally: the grandchild survives a wrapper kill on this
 * project's Linux containers, and does not on the GitHub runner. A suite that asserts a bug still
 * reproduces depends on the defect surviving everywhere it runs, which is backwards.
 *
 * Every process this file starts is reaped in its own `after`.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, openSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
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

/**
 * Is anything accepting TCP on `127.0.0.1:port`?
 *
 * THE LIVENESS PREDICATE, and it is deliberately NOT `serversOn`. That helper decides "running" by
 * matching THREE substrings on a `ps` line — `run-task.ts serve`, `--port <n>`, and
 * `tsx/dist/loader.mjs` — and returns `[]` on ANY failure, including `ps` itself erroring. So a
 * server that IS running reads as absent whenever the environment differs in any of four unrelated
 * ways: a `ps` that rejects those flags or truncates a ~250-char command line (`--port` sits at the
 * END of it), a tsx that does not interpose a child, a different tsx layout, or simple absence. All
 * four render identically, which is why the failure it produces says only "not running".
 *
 * MEASURED: this file's live tests pass on the GitHub runner and in this agent's container, and the
 * precondition assertion FAILED in the operator's Azure container — the same environment-dependence
 * #1509 hit one layer up, when its first negative control asserted the leak itself. A port bind is
 * the process's OWN readiness signal and depends on none of the four.
 */
function listeningOn(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (up: boolean) => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Poll {@link listeningOn} until the server answers, or the deadline passes. */
async function waitForListening(port: number, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await listeningOn(port)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
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

function startServe(port: number) {
  const home = mkdtempSync(join(tmpdir(), "serve-orphan-home-"));
  const out = openSync(join(home, "serve.out.log"), "a", 0o600);
  return spawn(join(repoRoot, "bin", "rmd"), ["serve", "--port", String(port), "--host", "127.0.0.1"], {
    stdio: ["ignore", out, out],
    env: { ...process.env, HOME: home },
    detached: true,
  });
}

test("killing the process GROUP reaps the serve process the tsx wrapper spawned", async (t) => {
  const port = await freePort();
  const child = startServe(port);
  // Belt and braces: whatever this test asserts, nothing survives it.
  t.after(() => killProcessGroup(child.pid!));

  // REACHING THE SPAWN IS ASSERTED FIRST — a teardown test that never started a process proves
  // nothing at all, which is the trap this whole file exists around. The signal is the PORT, not a
  // `ps` line: the server binds it, so a successful connect is the process's own readiness report
  // and is independent of `ps`, of tsx interposition, and of command-line formatting.
  assert.ok(
    await waitForListening(port),
    `nothing accepted a connection on 127.0.0.1:${port} within 45s — the serve process never started`,
  );

  killProcessGroup(child.pid!);
  await new Promise((r) => setTimeout(r, 1500));
  // THE PORT IS THE STRONGER CLAIM. "No `ps` line matches" only says a pattern stopped matching;
  // "nothing is listening" says the server is genuinely gone, which is what the group kill promises.
  assert.equal(await listeningOn(port), false, "no serve process may survive a group kill");
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

test("the spawned pid is the tsx wrapper, not the server — which is why a bare pid kill cannot reach it", async (t) => {
  const port = await freePort();
  const child = startServe(port);
  t.after(() => killProcessGroup(child.pid!));

  // THE SERVER MUST BE UP BEFORE ANYTHING IS JUDGED, and that is decided by the PORT — the one
  // signal every environment agrees on.
  assert.ok(
    await waitForListening(port),
    `nothing accepted a connection on 127.0.0.1:${port} within 45s — the serve process never started`,
  );

  // THIS TEST NEEDS A PID, SO IT NEEDS `ps` — AND THAT IS WHERE IT SKIPS RATHER THAN FAILS.
  // `serversOn` returns [] for four unrelated reasons (see `listeningOn`), only one of which is
  // "the fix is broken". The server is PROVEN UP by the port above, so an empty enumeration here is
  // a statement about this host's `ps`/tsx, not about the code — and #1509's own lesson is that a
  // test whose PRECONDITION is environment-dependent is the same defect as one whose ASSERTION is.
  // MEASURED: this assertion failed in the operator's Azure container while passing on the GitHub
  // runner and in the agent's container. The shape is still guarded EVERYWHERE by the source-
  // inspection test above, which needs no live process at all.
  const running = serversOn(port);
  if (running.length === 0) {
    t.skip(
      "ps enumerated no tsx-spawned serve process while the port WAS listening — this host cannot " +
        "observe the wrapper/child split, so the pid precondition is unobservable here rather than false",
    );
    return;
  }

  // THE LOAD-BEARING PRECONDITION, and the reason `detached` is not cargo: the process actually
  // serving is a DIFFERENT pid from the one `spawn` handed back. While that holds, a teardown built
  // on `child.pid` alone is aiming at the wrapper. If tsx ever stops interposing, this fails and the
  // fix should be revisited rather than trusted.
  assert.ok(
    running.every((pid) => pid !== child.pid),
    `the server pid(s) ${running.join(",")} must differ from the spawned pid ${child.pid}`,
  );

  // WHY THE LEAK ITSELF IS NOT ASSERTED HERE. An earlier revision asserted that killing only
  // `child.pid` leaves the grandchild alive. That reproduces on this project's Linux containers and
  // was the originally reported symptom, but it does NOT reproduce on the GitHub runner, where the
  // grandchild goes away with the wrapper — MEASURED: that assertion failed on CI twice, including
  // the flake retry, while passing locally. Asserting that a bug still reproduces makes the suite
  // depend on the defect surviving in every environment it runs in, which is backwards. The
  // precondition above is environment-independent and is what actually justifies the fix.
});
