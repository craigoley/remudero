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
 * (including the flake retry) while passing locally. A suite that asserts a bug still reproduces
 * depends on the defect surviving everywhere it runs, which is backwards, so the precondition above
 * is the right thing to lock either way.
 *
 * BUT THE REASON THAT REVISION FAILED WAS MISATTRIBUTED, AND THE CORRECTION MATTERS MORE THAN THE
 * CONCLUSION IT SUPPORTED. This header used to state that "the grandchild survives a wrapper kill on
 * this project's Linux containers, and does not on the GitHub runner." That was inferred from a red
 * CI run whose real cause is now established: the server NEVER STARTED on the runner at all, because
 * `startServe` gave it a fresh HOME and `loadConfig` died on `which claude`. Nothing about the
 * runner's process semantics was ever measured. That claim is WITHDRAWN as unsupported — it is not
 * known whether the grandchild survives a wrapper kill there, and no assertion in this file depends
 * on the answer.
 *
 * Every process this file starts is reaped in its own `after`.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
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
 * A PORT BIND IS THE PROCESS'S OWN READINESS SIGNAL and depends on none of the four. It is also
 * unforgeable in the direction that matters: a process that is crashing cannot accept a connection,
 * whereas it CAN carry a matching `ps` line for about a second while it dies.
 *
 * THE OLD NOTE HERE CLAIMED these live tests "pass on the GitHub runner". They did — and vacuously,
 * which is worse than failing. MEASURED with `claude` hidden from PATH, reproducing the runner: the
 * port NEVER binds inside 30s and the log reads `Error: Command failed: which claude`, yet the
 * ps-disjunct revision reported 3/3 green. The seed in {@link startServe} removes the cause, so this
 * predicate can now be the port alone without depending on which machine ran it.
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

/**
 * Is the server GONE — by BOTH observations?
 *
 * "GONE" IS THE CONJUNCTION AND STAYS ONE. Nothing may be listening AND no process may remain:
 * that is stricter than either signal alone and stricter than any earlier revision of this file
 * asserted, and neither half can be satisfied by the wrong machine.
 *
 * "UP" IS THE PORT ALONE — see {@link listeningOn}. The disjunction this used to compute for the
 * UP-check was the fourth revision's defect: MEASURED by a later recon, `ps` matches the DOOMED
 * process in 22 of 60 polls while it dies, so on a runner where the server never binds, "port OR
 * ps" is satisfied by a process that is already exiting. Both live tests went green on a machine
 * where the server had never once started. The disjunction was adopted to make a red CI green
 * without knowing why it was red; the cause is now known and fixed at its source (see
 * {@link startServe}), so the honest predicate is back.
 */
async function goneBy(port: number): Promise<{ port: boolean; ps: boolean; gone: boolean }> {
  const byPort = await listeningOn(port);
  const byPs = serversOn(port).length > 0;
  return { port: byPort, ps: byPs, gone: !byPort && !byPs };
}

/**
 * Poll until the PORT answers, or the deadline passes.
 *
 * THE PORT ALONE, DELIBERATELY. A bound port cannot be faked by a process that is crashing: only a
 * server that reached its `listen` can accept a connection. That is the whole property this file
 * needs before it judges a teardown, and it is the one signal that does not vary by host now that
 * the config seed removes the reason the server failed to start in CI.
 */
async function waitForListening(port: number, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await listeningOn(port)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * What the server itself said, for a failure message that can be acted on.
 *
 * THE FAILURE THIS REPLACES SAID ONLY "never started", which is the same
 * four-way-indistinguishable verdict this file was rewritten to eliminate one layer up. A probe
 * that cannot say WHY is how #1515 shipped a red suite: the runner reported a bare precondition
 * failure and the cause had to be guessed. The server's own log is the evidence.
 */
function serveDiagnostics(home: string, port: number): string {
  let log = "(no serve log)";
  try {
    log = readFileSync(join(home, "serve.out.log"), "utf8").trim() || "(serve log empty)";
  } catch (e) {
    log = `(serve log unreadable: ${String(e)})`;
  }
  let psSaw = "(ps unavailable)";
  try {
    psSaw = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes("run-task.ts serve"))
      .join("\n") || "(ps ran, matched no serve process)";
  } catch {
    /* ps itself is missing — leave the placeholder, which is itself the finding */
  }
  return `\n--- serve log (port ${port}) ---\n${log}\n--- ps saw ---\n${psSaw}\n`;
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

  // ── SEED THE CONFIG, OR THE SERVER NEVER STARTS IN CI ──────────────────────────────────────
  // HOME points at a FRESH temp dir, so `loadConfig` (src/lib/config.ts) finds no config and takes
  // its CREATE path — which calls `resolveClaudeBin()`, which shells `which claude` and THROWS.
  // Every GitHub runner lacks that binary; this container and the operator's Mac have it. That is
  // the whole reason this file passed locally and failed in CI, deterministically, on both the
  // attempt and the retry — and it went undiagnosed through four revisions.
  //
  // MEASURED here with `claude` hidden from PATH: without this seed the port NEVER binds inside 30s
  // and the log reads `Error: Command failed: which claude`; with it, the port binds in ~2.8s.
  //
  // THE PATH IS DELIBERATELY NONEXISTENT. Nothing in this file executes `claudeBin` — `rmd serve`
  // only needs the field present so the READ path is taken. Seeding a REAL binary (the sibling
  // test/serve-service-boot.test.ts uses `/bin/true`) would put a host dependency straight back in,
  // which is the exact class of defect this change exists to remove.
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/nonexistent/claude-not-installed", root: join(home, "Remudero") }),
  );

  const out = openSync(join(home, "serve.out.log"), "a", 0o600);
  const child = spawn(join(repoRoot, "bin", "rmd"), ["serve", "--port", String(port), "--host", "127.0.0.1"], {
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      HOME: home,
      // REQUIRED, NOT TIDINESS, and this file was violating the repo's own rule. `bin/rmd` runs
      // `checkCliFreshness` before the verb, which does `git merge --ff-only origin/main` on the
      // checkout — a network git operation, from a test, against whatever ref CI happens to have
      // fetched. `SELF_SYNC_GUARD_ENV` is the documented escape and the only safe form for a
      // spawn that is not deliberately syncing.
      RMD_SELF_SYNC_DONE: "1",
    },
    detached: true,
  });
  return { child, home };
}

test("killing the process GROUP reaps the serve process the tsx wrapper spawned", async (t) => {
  const port = await freePort();
  const { child, home } = startServe(port);
  // Belt and braces: whatever this test asserts, nothing survives it.
  t.after(() => killProcessGroup(child.pid!));

  // REACHING THE SPAWN IS ASSERTED FIRST — a teardown test that never started a process proves
  // nothing at all, which is the trap this whole file exists around. THE PORT IS THE SIGNAL: only a
  // server that reached `listen` can accept a connection, so a crashing process cannot satisfy it.
  // The failure carries the server's own log, because "never started" without a reason is what
  // turned one defect into four revisions.
  assert.ok(
    await waitForListening(port),
    `nothing accepted a connection on 127.0.0.1:${port} within 45s${serveDiagnostics(home, port)}`,
  );

  killProcessGroup(child.pid!);
  await new Promise((r) => setTimeout(r, 1500));
  // BOTH SIGNALS MUST GO QUIET, which is stricter than any earlier revision of this file: "no `ps`
  // line matches" alone only says a pattern stopped matching, and "nothing is listening" alone
  // would accept a process that survived with its socket closed. The group kill promises neither.
  const after = await goneBy(port);
  assert.equal(
    after.gone,
    true,
    `no serve process may survive a group kill (listening=${after.port}, ps=${after.ps})${serveDiagnostics(home, port)}`,
  );
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
  const { child, home } = startServe(port);
  t.after(() => killProcessGroup(child.pid!));

  // THE SERVER MUST BE UP BEFORE ANYTHING IS JUDGED, and that is the PORT — see
  // {@link waitForListening} for why a `ps` disjunct made this precondition satisfiable by a
  // process that was crashing.
  assert.ok(
    await waitForListening(port),
    `nothing accepted a connection on 127.0.0.1:${port} within 45s${serveDiagnostics(home, port)}`,
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
