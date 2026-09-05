/**
 * W1-T2586 — AN OPERATOR STOP DOES NOT STOP THE DAEMON.
 *
 * MEASURED 2026-09-01: `docker stop remudero-daemon` was run to end a live spend leak.
 * `deploy/entrypoint.sh` forwarded TERM to the daemon (W1-T1067), the daemon released its locks
 * and exited — and then died BY that re-raised signal, a killed-by-SIGTERM wait status of
 * 128+15=143 (`daemonCommand`'s own `onSignal`, src/run-task.ts, calls `processKill(process.pid,
 * sig)` once its cleanup is done, exactly as this suite's stand-in below does). Docker's
 * `on-failure` policy cannot tell 143 apart from a crash, and the entrypoint's own restart
 * throttle (120s in production) only SLOWS the relaunch, it does not prevent it — so the operator
 * saw `Exited`, believed the stop had worked, and the container came back 27 minutes later on its
 * own. The leak `docker stop` was reached for specifically to end ran a further 24 minutes and
 * ~$45 before anyone noticed it had never actually stopped.
 *
 * THE FIX IS IN THE ENTRYPOINT, NOT THE DAEMON. `deploy/entrypoint.sh` is the one thing that KNOWS
 * a stop was operator-requested — it is what received TERM/INT and chose to forward it — so it
 * marks that fact (`signal_forwarded`) at the moment it forwards, independent of whatever raw exit
 * status the signalled child eventually produces, and reports a clean exit (0) for it. That is
 * deliberately NOT a rule keyed on the exit code: inferring "clean" from the NUMBER 143 would also
 * launder a real crash that happens to die the same way (e.g. a daemon bug that raises SIGTERM at
 * itself unprompted), which is the opposite defect this task's own rationale warns against.
 *
 * REAL BASH, REAL SIGNALS — no `process.emit("SIGTERM")` stand-in. The claim under test is what a
 * REAL forwarded-and-handled TERM does to the CONTAINER's own exit code, and that lives entirely in
 * process wait-status plumbing (bash's `wait`, a self-re-raised signal, `docker`'s own exit-code
 * read) that a synthetic in-process signal cannot exercise. Mirrors the real primitive shape
 * test/drain-lock-restart-reclaim.test.ts already established for the FORWARDING half of W1-T1067;
 * this suite is the CLASSIFICATION half — whether the forwarded stop is reported as clean — and
 * uses a lightweight bash stand-in (cleanup, then re-raise itself with the default disposition
 * restored) because the classification logic under test lives entirely in the shell, not in Node.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "entrypoint.sh");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeOrigin(): string {
  const origin = tmp("op-stop-origin-");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
  writeFileSync(join(origin, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  spawnSync("git", ["add", "-A"], { cwd: origin });
  spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "c1"], {
    cwd: origin,
  });
  return origin;
}

function writeNpmStub(dir: string): void {
  writeFileSync(
    join(dir, "npm"),
    "#!/usr/bin/env bash\nif [ \"$1\" = \"ci\" ]; then mkdir -p node_modules/.bin; printf '#!/bin/sh\\n' > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi\nexit 0\n",
    { mode: 0o755 },
  );
  chmodSync(join(dir, "npm"), 0o755);
}

/**
 * A "daemon" stand-in that mirrors `daemonCommand`'s real `onSignal` shape (src/run-task.ts):
 * on TERM, do its cleanup (here: touch a marker — the real one releases the drain lock, closes the
 * event-wake watcher, consumes the STOP file), clear its own handler, and re-raise the SAME signal
 * against itself so it dies BY the signal for real — never a stand-in that merely reports receipt
 * and exits 0 on its own terms, which would prove nothing about the wait-status plumbing this task
 * is about. Verified directly (see the task's own dev notes): this produces wait status 143.
 */
function writeDaemonStandin(dir: string): string {
  const p = join(dir, "daemon-standin.sh");
  writeFileSync(
    p,
    [
      "#!/usr/bin/env bash",
      'started="$1"; cleaned="$2"',
      "trap 'touch \"$cleaned\"; trap - TERM; kill -TERM $$' TERM",
      // `bootAndSignal` treats this marker as readiness and may send TERM immediately. Publish it
      // only after the cleanup trap exists; the old order made `cleaned: false` a scheduler race.
      'touch "$started"',
      "while :; do sleep 0.1; done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(p, 0o755);
  return p;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, onTimeout: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(onTimeout);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface SignalledBoot {
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  stderr: string;
  cleaned: boolean;
}

/**
 * Boots `script` (defaults to the real entrypoint) supervising the daemon stand-in, waits for it
 * to actually start, sends TERM — exactly what `docker stop`/tini forwards on a live container —
 * and resolves once the CONTAINER's own process exits, with the elapsed time from the signal to
 * that exit. `throttleS` is set HIGH enough that "the fix did not apply and the full throttle sleep
 * ran anyway" is trivially distinguishable from "the operator stop was reported immediately".
 */
async function bootAndSignal(opts: { script?: string; throttleS: number }): Promise<SignalledBoot> {
  const home = tmp("op-stop-home-");
  const origin = makeOrigin();
  const stubs = tmp("op-stop-stub-");
  writeNpmStub(stubs);
  const standinDir = tmp("op-stop-standin-");
  const standin = writeDaemonStandin(standinDir);
  const started = join(standinDir, "started");
  const cleaned = join(standinDir, "cleaned");

  const child = spawn("bash", [opts.script ?? SCRIPT, "bash", standin, started, cleaned], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      RMD_RESTART_THROTTLE_S: String(opts.throttleS),
    },
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitFor(() => existsSync(started), 20_000, `the daemon stand-in never started: ${stderr}`);

    const sentAt = Date.now();
    child.kill("SIGTERM"); // exactly what tini/docker stop sends the supervised bash

    const { code, signal } = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`container never exited after TERM: ${stderr}`)), 20_000),
      ),
    ]);
    const elapsedMs = Date.now() - sentAt;
    return { code, signal, elapsedMs, stderr, cleaned: existsSync(cleaned) };
  } finally {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH: the whole group is already gone.
      }
    }
  }
}

// ── ACCEPTANCE 1: a TERM the entrypoint handles deliberately exits zero ────────────────────────

test("an operator TERM, forwarded and handled, reports a CLEAN exit — not a crash", async () => {
  // The throttle is set to 20s: if the fix did not apply, the pre-fix code would fall through to
  // the crash path below and sleep the FULL throttle before exiting non-zero. 20s makes "it slept
  // the whole throttle" and "it exited immediately" trivially distinguishable within the test's own
  // timeout, without the flakiness a tight number invites.
  const run = await bootAndSignal({ throttleS: 20 });
  assert.equal(run.cleaned, true, "the daemon must actually have run its own signal cleanup before dying");
  assert.equal(run.signal, null, "the entrypoint must itself exit via a normal process exit, not be killed by a signal");
  assert.equal(run.code, 0, `an operator stop must report a CLEAN exit so on-failure leaves the container down; got code=${run.code}`);
  assert.ok(
    run.elapsedMs < 5_000,
    `a handled stop must exit promptly, never after the 20s crash throttle: took ${run.elapsedMs}ms`,
  );
  assert.match(run.stderr, /operator stop handled/, "the entrypoint must say by name that this was a handled operator stop");
  assert.doesNotMatch(run.stderr, /sleeping 20s before exiting/, "a handled stop must never pay the crash throttle");
});

// ── ACCEPTANCE 2: a genuine failure still exits non-zero and keeps its restart throttle ────────

test("a genuine crash — no signal involved — still exits non-zero and pays the full crash throttle", () => {
  const home = tmp("op-stop-home-");
  const origin = makeOrigin();
  const stubs = tmp("op-stop-stub-");
  writeNpmStub(stubs);
  writeFileSync(join(stubs, "rmd-fake"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  chmodSync(join(stubs, "rmd-fake"), 0o755);

  const started = Date.now();
  const r = spawnSync("bash", [SCRIPT, "rmd-fake"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      RMD_RESTART_THROTTLE_S: "2",
    },
  });
  const elapsedMs = Date.now() - started;

  assert.equal(r.status, 1, "an ordinary, unsignalled crash must still propagate its own exit code");
  assert.ok(elapsedMs >= 2_000, `a real crash must still pay the full crash throttle, took ${elapsedMs}ms`);
  assert.doesNotMatch(r.stderr ?? "", /operator stop handled/, "a crash must never be reported as a handled operator stop");
});

// ── MUTANT: reverting the classification reproduces the MEASURED defect exactly ────────────────

function mutate(find: string, replace: string): string {
  const src = readFileSync(SCRIPT, "utf8");
  assert.equal(src.split(find).length - 1, 1, `the mutation target must be unique: ${JSON.stringify(find)}`);
  const dir = tmp("op-stop-mutant-");
  const p = join(dir, "entrypoint.sh");
  writeFileSync(p, src.replace(find, replace), { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

test("MUTANT (the measured defect): without the signal_forwarded short-circuit, a handled TERM still exits non-zero and gets throttled", async () => {
  // Strip the classification this task adds, leaving TERM-forwarding (W1-T1067) intact but with no
  // way to tell a handled stop apart from a crash — exactly `origin/main`'s state before this task,
  // and exactly the shape MEASURED 2026-09-01: cleanup runs, the process dies by the re-raised
  // signal, and the container still reports a non-zero exit that `on-failure` reads as a crash.
  const mutant = mutate(
    [
      '  # W1-T2586: A SIGNAL THIS SHELL ITSELF FORWARDED OUTRANKS EVERY OTHER CLASSIFICATION BELOW.',
      '  # `signal_forwarded` is set ONLY inside `forward_signal`, ONLY after TERM/INT was actually sent',
      '  # to a live child — so reaching here with it set means an operator (or a supervisor\'s `docker',
      '  # stop`) asked this container to shut down, the daemon was told, and it exited AS A RESULT,',
      '  # whatever its raw wait status ($rc, typically 143 — 128+SIGTERM). That is what a graceful',
      '  # operator stop means to every process supervisor: exit 0, and RIGHT NOW, never after the crash',
      '  # throttle below. THE UNSIGNALED PATHS ARE ALL LEFT ALONE: this branch cannot fire without a',
      '  # real forwarded signal, so a genuine crash (no signal, non-zero $rc) still falls through to',
      "  # the non-zero handling further down and is still counted by docker exactly as before.",
      '  if [ -n "$signal_forwarded" ]; then',
      '    log "operator stop handled: $sig was forwarded and the daemon exited $rc as a result — reporting a CLEAN exit (0) so on-failure does not read a deliberate stop as a crash"',
      "    exit 0",
      "  fi",
      "",
    ].join("\n"),
    "",
  );

  const run = await bootAndSignal({ script: mutant, throttleS: 2 });
  assert.equal(run.cleaned, true, "the mutant must still forward the signal and run cleanup — only the classification is gone");
  assert.notEqual(run.code, 0, "the pre-fix mutant must reproduce the defect: a handled stop is still reported as a crash");
  assert.ok(run.elapsedMs >= 2_000, `the mutant must still pay the crash throttle, took ${run.elapsedMs}ms`);
});
