/**
 * test/serve-service-boot.test.ts — W1-T152, the one criterion that CANNOT be proven against a
 * pure function: does the console's startup banner reach a redirected log file WHILE the
 * process is still running?
 *
 * WHY IT MATTERS. Under the launchd unit `rmd serve-plist` generates, stdout is not a terminal
 * — it is `<root>/state/logs/serve.out.log`. Node switches stdout to a different write path
 * for a non-TTY, and a fully-buffered stdout would mean the operator sees an EMPTY log until
 * the process exits: exactly wrong for a service whose whole point is to never exit, and the
 * shape of the original outage (a relaunch died into an unread log while the old process kept
 * serving). The falsifier is a banner readable only after exit.
 *
 * ITS OWN FILE on purpose: this is the only test in the suite that spawns the real CLI and
 * binds a real port. If it ever flakes it must not take a coverage-load-bearing file down with
 * it (the run-task.test.ts file-level-crash lesson).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { killProcessGroup } from "../src/lib/worker-containment.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** A port nobody holds right now — asked of the OS rather than guessed. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("serve's startup banner is readable in a redirected log BEFORE the process exits", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-serveboot-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const logPath = join(home, "serve.out.log");
  const port = await freePort();

  const out = openSync(logPath, "a", 0o600);
  const child = spawn(join(repoRoot, "bin", "rmd"), ["serve", "--port", String(port), "--host", "127.0.0.1"], {
    // NON-TTY stdout, redirected to a file — the launchd unit's exact shape.
    stdio: ["ignore", out, out],
    // `--host` above is also the end-to-end proof of its own arg-validator fix: before W1-T152
    // it exited 2 as an "unexpected argument" despite being documented in USAGE.
    env: {
      ...process.env,
      HOME: home,
      // REQUIRED, NOT TIDINESS — the sibling test/serve-orphan-teardown.test.ts earned this
      // guard for `checkCliFreshness`'s network git and this file never got it back-ported.
      // For a `serve` child the stake is higher than a network git op: without the guard the
      // child runs `serviceFreshnessGate` → the REAL `ensureInstallFresh`, and on a missing or
      // stale `.rmd-install-hash` marker, a REAL UNATTENDED `npm ci` in this checkout — whose
      // clear phase follows a worktree's `node_modules` symlink and EMPTIES THE SHARED
      // CANONICAL TREE (measured forensically 2026-08-11; the 2026-07-29 daemon-outage
      // mechanism, and the likely cause of every unexplained node_modules wipe since). The
      // guarded early return is proven BEHAVIORALLY — not by this env var's presence — in
      // test/install-symlink-refusal.test.ts, where an identical child WITHOUT the guard
      // visibly reaches the install path and one WITH it visibly does not.
      RMD_SELF_SYNC_DONE: "1",
    },
    // OWN PROCESS GROUP, so teardown can reach the WHOLE tree. `bin/rmd` `exec`s
    // `node_modules/.bin/tsx`, and the tsx CLI then SPAWNS A CHILD `node` that is the process
    // actually running `src/run-task.ts serve`. `child.pid` is tsx's, not the server's, so
    // `child.kill()` killed the wrapper and left the grandchild alive — re-parented to PID 1 and
    // still holding its port. MEASURED before this fix: one orphaned
    // `node ... src/run-task.ts serve --port <n>` survived every single invocation of this suite,
    // on the PASSING path, and nothing reaps it: the daemon's `sweepOrphanWorkers` requires both
    // REMUDERO_RUN_ID and REMUDERO_TASK_ID markers (`defaultReadMarkers`) and deliberately leaves
    // an unattributable process alone.
    detached: true,
  });
  // Kill the GROUP, not the pid — `killProcessGroup` is the same helper the daemon's orphan sweep
  // uses, and it tolerates ESRCH so a child that already exited is not an error. `t.after` runs on
  // the failure path as well as the success path, which is why both are asserted in
  // test/serve-orphan-teardown.test.ts.
  t.after(() => {
    killProcessGroup(child.pid!);
  });

  let banner = "";
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const text = readFileSync(logPath, "utf8");
      if (text.includes("listening on")) {
        banner = text;
        break;
      }
    }
    if (child.exitCode !== null) {
      assert.fail(`serve exited (${child.exitCode}) before printing its banner. Log:\n${readFileSync(logPath, "utf8")}`);
    }
    await sleep(200);
  }

  assert.notEqual(banner, "", "the banner never appeared in the redirected log within 45s");
  assert.equal(child.exitCode, null, "…and it appeared while serve was STILL RUNNING — the whole point");
  assert.match(banner, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));
  assert.doesNotMatch(banner, /write token: [0-9a-f]{64}/, "the write token is never echoed to a log (R-5)");
});
